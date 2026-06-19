import logging
import os
import platform
import time
import docker
import psutil
import requests
from filelock import FileLock
from pathlib import Path

from desktop_env.providers.base import Provider

logger = logging.getLogger("desktopenv.providers.docker.DockerProvider")
logger.setLevel(logging.INFO)

WAIT_TIME = 3
RETRY_INTERVAL = 1
LOCK_TIMEOUT = 10


class PortAllocationError(Exception):
    pass


class DockerProvider(Provider):
    def __init__(self, region: str):
        self.client = docker.from_env()
        self.server_port = None
        self.vnc_port = None
        self.chromium_port = None
        self.vlc_port = None
        self.container = None
        self.environment = {
            "DISK_SIZE": os.getenv("OSWORLD_DOCKER_DISK_SIZE", "32G"),
            "RAM_SIZE": os.getenv("OSWORLD_DOCKER_RAM_SIZE", "4G"),
            "CPU_CORES": os.getenv("OSWORLD_DOCKER_CPU_CORES", "4"),
            # Docker Desktop can report zero available RAM inside nested emulation.
            # Disable strict RAM check by default to allow boot on those hosts.
            "RAM_CHECK": os.getenv("OSWORLD_DOCKER_RAM_CHECK", "N"),
        }

        temp_dir = Path(os.getenv('TEMP') if platform.system() == 'Windows' else '/tmp')
        self.lock_file = temp_dir / "docker_port_allocation.lck"
        self.lock_file.parent.mkdir(parents=True, exist_ok=True)

    def _get_used_ports(self):
        """Get all currently used ports (both system and Docker)."""
        # Get system ports -- use socket binding as fallback for macOS permission issues
        system_ports: set[int] = set()
        try:
            system_ports = set(conn.laddr.port for conn in psutil.net_connections())
        except (psutil.AccessDenied, PermissionError):
            # On macOS, psutil.net_connections() may fail without elevated permissions.
            # Fall back to empty set -- Docker port check below still works.
            logger.warning("psutil.net_connections() denied; falling back to Docker-only port check")
        
        # Get Docker container ports
        docker_ports: set[int] = set()
        for container in self.client.containers.list():
            ports = container.attrs['NetworkSettings']['Ports']
            if ports:
                for port_mappings in ports.values():
                    if port_mappings:
                        docker_ports.update(int(p['HostPort']) for p in port_mappings)
        
        return system_ports | docker_ports

    def _get_available_port(self, start_port: int) -> int:
        """Find next available port starting from start_port."""
        import socket
        used_ports = self._get_used_ports()
        port = start_port
        while port < 65354:
            if port not in used_ports:
                # Verify with socket bind (reliable on macOS)
                try:
                    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                        s.bind(("", port))
                    return port
                except OSError:
                    pass
            port += 1
        raise PortAllocationError(f"No available ports found starting from {start_port}")

    def _wait_for_vm_ready(self, timeout: int = 3600):
        """Wait for VM to be ready by checking screenshot endpoint."""
        start_time = time.time()
        
        def check_screenshot():
            try:
                response = requests.get(
                    f"http://localhost:{self.server_port}/screenshot",
                    timeout=(10, 10)
                )
                return response.status_code == 200
            except Exception:
                return False

        while time.time() - start_time < timeout:
            if check_screenshot():
                return True
            logger.info("Checking if virtual machine is ready...")
            time.sleep(RETRY_INTERVAL)
        
        raise TimeoutError("VM failed to become ready within timeout period")

    def start_emulator(self, path_to_vm: str, headless: bool, os_type: str):
        # Use a single lock for all port allocation and container startup
        lock = FileLock(str(self.lock_file), timeout=LOCK_TIMEOUT)
        
        try:
            with lock:
                # Allocate all required ports
                self.vnc_port = self._get_available_port(8006)
                self.server_port = self._get_available_port(5000)
                self.chromium_port = self._get_available_port(9222)
                self.vlc_port = self._get_available_port(8080)

                # Start container while still holding the lock
                # Check if KVM is available
                devices = []
                if os.path.exists("/dev/kvm"):
                    devices.append("/dev/kvm")
                    logger.info("KVM device found, using hardware acceleration")
                else:
                    self.environment["KVM"] = "N"
                    logger.warning("KVM device not found, running without hardware acceleration (will be slower)")

                self.container = self.client.containers.run(
                    "happysixd/osworld-docker",
                    environment=self.environment,
                    cap_add=["NET_ADMIN"],
                    devices=devices,
                    volumes={
                        os.path.abspath(path_to_vm): {
                            "bind": "/System.qcow2",
                            "mode": "ro"
                        }
                    },
                    ports={
                        8006: self.vnc_port,
                        5000: self.server_port,
                        9222: self.chromium_port,
                        8080: self.vlc_port
                    },
                    detach=True
                )

            logger.info(f"Started container with ports - VNC: {self.vnc_port}, "
                       f"Server: {self.server_port}, Chrome: {self.chromium_port}, VLC: {self.vlc_port}")

            # Wait for VM to be ready
            vm_ready_timeout = int(os.getenv("OSWORLD_VM_READY_TIMEOUT_SECONDS", "3600"))
            self._wait_for_vm_ready(timeout=vm_ready_timeout)

        except Exception as e:
            # Clean up if anything goes wrong
            if self.container:
                try:
                    self.container.stop()
                    self.container.remove()
                except:
                    pass
            raise e

    def get_ip_address(self, path_to_vm: str) -> str:
        if not all([self.server_port, self.chromium_port, self.vnc_port, self.vlc_port]):
            raise RuntimeError("VM not started - ports not allocated")
        return f"localhost:{self.server_port}:{self.chromium_port}:{self.vnc_port}:{self.vlc_port}"

    def save_state(self, path_to_vm: str, snapshot_name: str):
        raise NotImplementedError("Snapshots not available for Docker provider")

    def revert_to_snapshot(self, path_to_vm: str, snapshot_name: str):
        self.stop_emulator(path_to_vm)

    def stop_emulator(self, path_to_vm: str, region=None, *args, **kwargs):
        # Note: region parameter is ignored for Docker provider
        # but kept for interface consistency with other providers
        if self.container:
            logger.info("Stopping VM...")
            try:
                self.container.stop()
                self.container.remove()
                time.sleep(WAIT_TIME)
            except Exception as e:
                logger.error(f"Error stopping container: {e}")
            finally:
                self.container = None
                self.server_port = None
                self.vnc_port = None
                self.chromium_port = None
                self.vlc_port = None
