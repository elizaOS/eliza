from python_on_whales import DockerClient, Image, Container
import os
import tempfile
from typing import List, Dict, Optional, Any, Tuple, Union
from pathlib import Path

from logging_config import get_logger

logger = get_logger(__name__)


class DockerHostInfo:
    """Docker Host Info Class"""

    def __init__(self, hostname: str, username: Optional[str] = None, password: Optional[str] = None,
                 tls_verify: Optional[bool] = None, cert_path: Optional[str] = None):
        self.hostname = hostname
        self.username = username
        self.password = password
        self.tls_verify = tls_verify
        self.cert_path = cert_path or "/root/.docker"


def create_docker_client(host_info: DockerHostInfo) -> DockerClient:
    """Create Docker Client Connection

    Args:
        host_info: Docker Host Info

    Returns:
        Docker Client Instance
    """
    try:
        hostname = host_info.hostname

        if hostname in ['localhost', '127.0.0.1', 'local']:
            # 本地连接
            client = DockerClient()
            logger.info(f"Successfully created local Docker client connection: {hostname}")
            return client

        # 判断是否为TLS远程连接
        is_tls = hostname.startswith("https://") or (":2376" in hostname and not hostname.startswith("unix://"))

        if is_tls:
            
            # Handle TLS remote connection - remove https:// prefix, use tcp://
            if hostname.startswith("https://"):
                docker_host = "tcp://" + hostname[8:]  # Remove "https://" prefix
            elif not hostname.startswith("tcp://"):
                docker_host = "tcp://" + hostname
            else:
                docker_host = hostname

            # Set TLS verification (default to True if not specified)
            tls_verify = host_info.tls_verify if host_info.tls_verify is not None else True

            # Configure TLS environment variables, as python-on-whales uses Docker CLI
            original_docker_host = os.environ.get('DOCKER_HOST')
            original_docker_tls_verify = os.environ.get('DOCKER_TLS_VERIFY')
            original_docker_cert_path = os.environ.get('DOCKER_CERT_PATH')

            try:
                # Set Docker environment variables for TLS connection
                os.environ['DOCKER_HOST'] = docker_host

                if tls_verify:
                    os.environ['DOCKER_TLS_VERIFY'] = '1'
                    if host_info.cert_path:
                        os.environ['DOCKER_CERT_PATH'] = host_info.cert_path
                else:
                    # Clear TLS verification environment variables if not using TLS
                    if 'DOCKER_TLS_VERIFY' in os.environ:
                        del os.environ['DOCKER_TLS_VERIFY']
                    if 'DOCKER_CERT_PATH' in os.environ:
                        del os.environ['DOCKER_CERT_PATH']

                # Create Docker client, python-on-whales will automatically read environment variables
                client = DockerClient()
                logger.info(f"Successfully created TLS Docker client connection: {docker_host}, TLS verify: {tls_verify}")

                # Restore original environment variables
                if original_docker_host is not None:
                    os.environ['DOCKER_HOST'] = original_docker_host
                else:
                    os.environ.pop('DOCKER_HOST', None)

                if original_docker_tls_verify is not None:
                    os.environ['DOCKER_TLS_VERIFY'] = original_docker_tls_verify
                else:
                    os.environ.pop('DOCKER_TLS_VERIFY', None)

                if original_docker_cert_path is not None:
                    os.environ['DOCKER_CERT_PATH'] = original_docker_cert_path
                else:
                    os.environ.pop('DOCKER_CERT_PATH', None)

                return client

            except Exception as e:
                # Restore original environment variables if any exception occurs
                if original_docker_host is not None:
                    os.environ['DOCKER_HOST'] = original_docker_host
                else:
                    os.environ.pop('DOCKER_HOST', None)

                if original_docker_tls_verify is not None:
                    os.environ['DOCKER_TLS_VERIFY'] = original_docker_tls_verify  
                else:
                    os.environ.pop('DOCKER_TLS_VERIFY', None)

                if original_docker_cert_path is not None:
                    os.environ['DOCKER_CERT_PATH'] = original_docker_cert_path
                else:
                    os.environ.pop('DOCKER_CERT_PATH', None)
                raise e

        else:
            # Handle local connection or non-TLS remote connection
            if "/var/run/docker.sock" in hostname or "/docker-cli.sock" in hostname:
                host_url = "unix:///var/run/docker.sock"
            else:
                
                # Add default port if not specified
                if ":" not in hostname:
                    host_url = f"tcp://{hostname}:2375"
                else:
                    host_url = f"tcp://{hostname}" if not hostname.startswith("tcp://") else hostname

            client = DockerClient(host=host_url)
            logger.info(f"Successfully created non-TLS Docker client connection: {host_url}")
            
        return client
    except Exception as e:
        logger.error(f"Create Docker client failed: {e}")
        raise RuntimeError(f"Create Docker client failed: {e}")


def verify_docker_connection(host_info: DockerHostInfo) -> bool:
    """Verify if the Docker host connection is normal

    Args:
        host_info: Docker host information

    Returns:
        Whether the Docker host connection is normal
    """
    try:
        client = create_docker_client(host_info)
        # try to get docker version to verify connection
        client.version()
        logger.info(f"Successfully connected to Docker host: {host_info.hostname}")
        return True
    except Exception as e:
        logger.error(f"Failed to connect to Docker host: {e}")
        return False


def get_docker_info(host_info: DockerHostInfo) -> Dict[str, Any]:
    """Get Docker host information

    Args:
        host_info: Docker host information

    Returns:
        Docker system information
    """
    try:
        client = create_docker_client(host_info)
        info = client.info()
        logger.info(f"Successfully retrieved Docker host information: {host_info.hostname}")
        return info
    except Exception as e:
        logger.error(f"Failed to retrieve Docker host information: {e}")
        raise RuntimeError(f"Failed to retrieve Docker host information: {e}")


# ==================== 镜像操作 ====================

def list_images(host_info: DockerHostInfo, all_images: bool = True) -> List[Image]:
    """List all Docker images

    Args:
        host_info: Docker host information
        all_images: Whether to show all images (including intermediate layers)

    Returns:
        List of Docker images
    """
    try:
        client = create_docker_client(host_info)
        images = client.image.list(all_images)
        logger.info(f"Successfully retrieved image list, total {len(images)} images")
        return images
    except Exception as e:
        logger.error(f"Failed to list images: {e}")
        raise RuntimeError(f"Failed to list images: {e}")


def pull_image(host_info: DockerHostInfo, image_name: str, tag: str = "latest") -> Image:
    """Pull Docker image

    Args:
        host_info: Docker host information
        image_name: Image name
        tag: Image tag

    Returns:
        Pulled Docker image object
    """
    try:
        client = create_docker_client(host_info)

        # If image_name already contains tag, use it directly, otherwise add tag
        if ':' in image_name:
            full_image_name = image_name
        else:
            full_image_name = f"{image_name}:{tag}" if tag else image_name

        logger.info(f"Start pulling image: {full_image_name}")

        image = client.image.pull(full_image_name)
        logger.info(f"Successfully pulled image: {full_image_name}")
        return image
    except Exception as e:
        logger.error(f"Failed to pull image: {e}")
        raise RuntimeError(f"Failed to pull image: {e}")


def push_image(host_info: DockerHostInfo, image_name: str, tag: str = "latest") -> Dict[str, Any]:
    """Push Docker image

    Args:
        host_info: Docker host information
        image_name: Image name
        tag: Image tag

    Returns:
        Push result information
    """
    try:
        client = create_docker_client(host_info)

        # 如果镜像名称已经包含标签，直接使用，否则添加标签
        if ':' in image_name:
            full_image_name = image_name
        else:
            full_image_name = f"{image_name}:{tag}" if tag else image_name

        logger.info(f"Start pushing image: {full_image_name}")

        client.image.push(full_image_name)
        logger.info(f"Successfully pushed image: {full_image_name}")
        return {"status": "success", "image": full_image_name}
    except Exception as e:
        logger.error(f"Failed to push image: {e}")
        raise RuntimeError(f"Failed to push image: {e}")


def tag_image(host_info: DockerHostInfo, source_image: str, target_image: str, tag: str = "latest") -> bool:
    """Tag Docker image

    Args:
        host_info: Docker host information
        source_image: Source image name
        target_image: Target image name
        tag: Image tag

    Returns:
        Whether the tagging operation is successful
    """
    try:
        client = create_docker_client(host_info)
        target_with_tag = f"{target_image}:{tag}"
        logger.info(f"Start tagging image: {source_image} -> {target_with_tag}")

        client.image.tag(source_image, target_with_tag)
        logger.info(f"Successfully tagged image: {source_image} -> {target_with_tag}")
        return True
    except Exception as e:
        logger.error(f"Failed to tag image: {e}")
        raise RuntimeError(f"Failed to tag image: {e}")


def remove_image(host_info: DockerHostInfo, image_id: str, force: bool = False) -> List[str]:
    """Remove Docker image

    Args:
        host_info: Docker host information
        image_id: Image ID or name
        force: Whether to force deletion

    Returns:
        Delete operation results
    """
    try:
        client = create_docker_client(host_info)
        logger.info(f"Start removing image: {image_id}, force: {force}")

        client.image.remove(image_id, force=force)
        logger.info(f"Successfully removed image: {image_id}")
        return [{"Deleted": image_id}]
    except Exception as e:
        logger.error(f"Failed to remove image: {e}")
        raise RuntimeError(f"Failed to remove image: {e}")


def build_image(host_info: DockerHostInfo, dockerfile_path: str, tag: str, build_context_path: str = None) -> Tuple[Image, List[str]]:
    """Build Docker image

    Args:
        host_info: Docker host information
        dockerfile_path: Dockerfile path
        tag: Image tag
        build_context_path: Build context path, default to Dockerfile directory

    Returns:
        Built Docker image object and build logs
    """
    try:
        client = create_docker_client(host_info)

        if build_context_path is None:
            build_context_path = os.path.dirname(dockerfile_path)

        logger.info(f"Start building image, Dockerfile path: {dockerfile_path}, tag: {tag}")

        logs = []

        # 使用python-on-whales构建镜像
        image = client.image.build(
            context_path=build_context_path,
            file=dockerfile_path,
            tags=[tag]
        )

        logger.info(f"Successfully built image, tag: {tag}")
        return image, logs
    except Exception as e:
        logger.error(f"Failed to build image: {e}")
        raise RuntimeError(f"Failed to build image: {e}")


# ==================== 容器操作 ====================

def list_containers(host_info: DockerHostInfo, all_containers: bool = True) -> List[Container]:
    """List Docker containers

    Args:
        host_info: Docker host information
        all_containers: Whether to show all containers (including stopped ones)

    Returns:
        Container list
    """
    try:
        client = create_docker_client(host_info)
        containers = client.container.list(all=all_containers)
        logger.info(f"Successfully retrieved container list, total {len(containers)} containers")
        return containers
    except Exception as e:
        logger.error(f"Failed to list containers: {e}")
        raise RuntimeError(f"Failed to list containers: {e}")


def create_container(host_info: DockerHostInfo, image_name: str, container_name: str = None, **kwargs) -> Container:
    """Create Docker container

    Args:
        host_info: Docker host information
        image_name: Image name
        container_name: Container name
        **kwargs: Other container configuration parameters

    Returns:
        Created container object
    """
    try:
        client = create_docker_client(host_info)
        logger.info(f"Create container: {container_name or 'auto-named'} based on image: {image_name}")

        container = client.container.create(
            image_name, 
            name=container_name,
            **kwargs
        )
        logger.info(f"Successfully created container, ID: {container.id}")
        return container
    except Exception as e:
        logger.error(f"Failed to create container: {e}")
        raise RuntimeError(f"Failed to create container: {e}")


def run_container(host_info: DockerHostInfo, image_name: str, container_name: str = None, 
                 command: Optional[Union[str, List[str]]] = None,
                 environment: Optional[Dict[str, str]] = None,
                 ports: Optional[Dict[str, int]] = None,
                 volumes: Optional[List[Tuple[str, str, str]]] = None,
                 detach: bool = True, **kwargs) -> Container:
    """Run Docker container

    Args:
        host_info: Docker主机信息
        image_name: 镜像名称
        container_name: Container name
        command: Command to run
        environment: Environment variables dictionary
        ports: Port mappings dictionary {'container_port': host_port}
        volumes: Volume mounts list [('host_path', 'container_path', 'mode')]
        detach: Whether to run in detached mode
        **kwargs: Other container configuration parameters

    Returns:
        Running container object
    """
    try:
        client = create_docker_client(host_info)
        logger.info(f"Run container: {container_name or 'auto-named'} based on image: {image_name}")

        # Convert port mappings to tuple format expected by python-on-whales
        publish = []
        if ports:
            for container_port, host_port in ports.items():
  
                # Remove protocol suffix (e.g., /tcp) if present
                clean_container_port = container_port.split('/')[0] if '/' in str(container_port) else container_port
                publish.append((host_port, clean_container_port))

        # Build run arguments, only include non-None values
        run_kwargs = {
            "name": container_name,
            "command": command,
            "publish": publish if publish else None,
            "volumes": volumes,
            "detach": detach,
            **kwargs
        }

        # Only add envs parameter if environment is not None
        if environment is not None:
            run_kwargs["envs"] = environment

        # Remove None values from run_kwargs
        run_kwargs = {k: v for k, v in run_kwargs.items() if v is not None}

        container = client.container.run(image_name, **run_kwargs)

        logger.info(f"Container run completed, ID: {container.id}")
        return container
    except Exception as e:
        logger.error(f"Failed to run container: {e}")
        raise RuntimeError(f"Failed to run container: {e}")


def start_container(host_info: DockerHostInfo, container_id: str) -> None:
    """Start Docker container

    Args:
        host_info: Docker host information
        container_id: Container ID or name
    """
    try:
        client = create_docker_client(host_info)
        logger.info(f"Start container: {container_id}")

        client.container.start(container_id)
        logger.info(f"Container started: {container_id}")
    except Exception as e:
        logger.error(f"Failed to start container: {e}")
        raise RuntimeError(f"Failed to start container: {e}")


def stop_container(host_info: DockerHostInfo, container_id: str, timeout: int = 10) -> None:
    """Stop Docker container

    Args:
        host_info: Docker host information
        container_id: Container ID or name
        timeout: Timeout in seconds
    """
    try:
        client = create_docker_client(host_info)
        logger.info(f"Stop container: {container_id}, timeout: {timeout} seconds")

        client.container.stop(container_id, time=timeout)
        logger.info(f"Container stopped: {container_id}")
    except Exception as e:
        logger.error(f"Failed to stop container: {e}")
        raise RuntimeError(f"Failed to stop container: {e}")


def restart_container(host_info: DockerHostInfo, container_id: str, timeout: int = 10) -> None:
    """Restart Docker container

    Args:
        host_info: Docker host information
        container_id: Container ID or name
        timeout: Timeout in seconds
    """
    try:
        client = create_docker_client(host_info)
        logger.info(f"Restart container: {container_id}, timeout: {timeout} seconds")

        client.container.restart(container_id, time=timeout)
        logger.info(f"Container restarted: {container_id}")
    except Exception as e:
        logger.error(f"Failed to restart container: {e}")
        raise RuntimeError(f"Failed to restart container: {e}")


def remove_container(host_info: DockerHostInfo, container_id: str, force: bool = False) -> None:
    """Remove Docker container

    Args:
        host_info: Docker host information
        container_id: Container ID or name
        force: Whether to force removal of running containers
    """
    try:
        client = create_docker_client(host_info)
        logger.info(f"Remove container: {container_id}, force: {force}")

        client.container.remove(container_id, force=force)
        logger.info(f"Container removed: {container_id}")
    except Exception as e:
        logger.error(f"Failed to remove container: {e}")
        raise RuntimeError(f"Failed to remove container: {e}")


def get_container_info(host_info: DockerHostInfo, container_id: str) -> Dict[str, Any]:
    """Get Docker container details

    Args:
        host_info: Docker host information
        container_id: Container ID or name

    Returns:
        Container details dictionary
    """
    try:
        client = create_docker_client(host_info)
        container = client.container.inspect(container_id)
        return container
    except Exception as e:
        logger.error(f"Failed to get container info: {e}")
        raise RuntimeError(f"Failed to get container info: {e}")


def get_container_logs(host_info: DockerHostInfo, container_id: str, tail: str = "all", 
                      timestamps: bool = False, follow: bool = False) -> str:
    """Get Docker container logs

    Args:
        host_info: Docker host information
        container_id: Container ID or name
        tail: Number of lines to display from the end of logs
        timestamps: Whether to include timestamps in logs
        follow: Whether to follow log output

    Returns:
        Container log content
    """
    try:
        client = create_docker_client(host_info)

        # 转换tail参数
        tail_num = None if tail == "all" else int(tail)

        logs = client.container.logs(
            container_id, 
            tail=tail_num, 
            timestamps=timestamps, 
            follow=follow
        )
        return logs
    except Exception as e:
        logger.error(f"Failed to get container logs: {e}")
        raise RuntimeError(f"Failed to get container logs: {e}")


def create_advanced_container(host_info: DockerHostInfo, image_name: str, container_name: str = None,
                            env_vars: Optional[Dict[str, str]] = None,
                            ports: Optional[Dict[str, int]] = None,
                            volumes: Optional[List[Tuple[str, str, str]]] = None,
                            command: Optional[Union[str, List[str]]] = None,
                            auto_remove: bool = False,
                            extra_hosts: Optional[Dict[str, str]] = None,
                            pull_always: bool = False,
                            network_mode: Optional[str] = None,
                            working_dir: Optional[str] = None,
                            user: Optional[str] = None,
                            privileged: bool = False,
                            **kwargs) -> Container:
    """Create advanced Docker container with specified configuration

    Args:
        host_info: Docker host information
        image_name: Image name
        container_name: Container name
        env_vars: Environment variables dictionary
        ports: Port mappings dictionary {'container_port': host_port}
        volumes: Volume mounts list [('host_path', 'container_path', 'mode')]
        command: Start command
        auto_remove: Whether to remove container when it stops
        extra_hosts: Extra host mappings dictionary {'hostname': 'IP'}
        pull_always: Whether to always pull image
        network_mode: Network mode
        working_dir: Working directory
        user: Run user
        privileged: Whether to run container in privileged mode
        **kwargs: Other container configuration parameters

    Returns:
        Created and started container object
    """
    try:
        client = create_docker_client(host_info)
        logger.info(f"Create advanced container: {container_name or 'auto-named'} based on image: {image_name}")

        # 如果需要总是拉取镜像
        if pull_always:
            logger.info(f"Always pull image mode, start pulling latest image: {image_name}")
            try:
                pull_image(host_info, image_name)
            except Exception as e:
                logger.warning(f"Failed to pull latest image: {e}, continue using local image")

        # 处理卷挂载路径中的波浪线
        if volumes:
            processed_volumes = []
            for host_path, container_path, mode in volumes:
                if host_path.startswith("~"):
                    host_path = os.path.expanduser(host_path)
                    logger.info(f"Replace tilde path with user home directory: {host_path}")
                processed_volumes.append((host_path, container_path, mode))
            volumes = processed_volumes


        # Convert port mappings 
        publish = []
        if ports:
            for container_port, host_port in ports.items():
       
                # Remove protocol suffix if exists
                clean_container_port = container_port.split('/')[0] if '/' in str(container_port) else container_port
                publish.append((host_port, clean_container_port))

        # Convert extra hosts mappings
        add_hosts_list = []
        if extra_hosts:
            for hostname, ip in extra_hosts.items():
                add_hosts_list.append((hostname, ip))

        # Build run kwargs, only include non-None and non-empty values
        run_kwargs = {
            "name": container_name,
            "command": command,
            "publish": publish if publish else None,
            "volumes": volumes,
            "remove": auto_remove,
            "add_hosts": add_hosts_list if add_hosts_list else None,
            "networks": [network_mode] if network_mode else None,
            "workdir": working_dir,
            "user": user,
            "privileged": privileged,
            "detach": True,
            **kwargs
        }

        # Only add env_vars if it's not None
        if env_vars is not None:
            run_kwargs["envs"] = env_vars

        # Remove None values from kwargs
        run_kwargs = {k: v for k, v in run_kwargs.items() if v is not None}

        container = client.container.run(image_name, **run_kwargs)

        logger.info(f"Create and start advanced container: {container_name or 'auto-named'} with ID: {container.id}")
        return container
    except Exception as e:
        logger.error(f"Create and start advanced container failed: {e}")
        raise RuntimeError(f"Create and start advanced container failed: {e}")


# ==================== File Operations ====================

def copy_file_to_container(host_info: DockerHostInfo, container_id: str, host_path: str, container_path: str) -> None:
    """Copy file from host to container

    Args:
        host_info: Docker host information
        container_id: Container ID or name
        host_path: Path to file on host
        container_path: Destination path in container
    """
    try:
        client = create_docker_client(host_info)
        logger.info(f"Copy file from host: {host_path} to container: {container_id} at path: {container_path}")

        if not os.path.exists(host_path):
            raise RuntimeError(f"Host file does not exist: {host_path}")

        client.container.cp(host_path, f"{container_id}:{container_path}")
        logger.info("File copy to container completed successfully")

    except Exception as e:
        logger.error(f"Copy file to container failed: {e}")
        raise RuntimeError(f"Copy file to container failed: {e}")


def copy_bytes_to_container(host_info: DockerHostInfo, container_id: str, data: bytes, container_path: str) -> None:
    """Copy bytes data to container file

    Args:
        host_info: Docker host information
        container_id: Container ID or name
        data: Bytes data to copy
        container_path: Destination path in container (including filename)
    """
    try:
        client = create_docker_client(host_info)
        logger.info(f"Copy bytes data to container: {container_id} at path: {container_path}")

        # Create temporary file
        with tempfile.NamedTemporaryFile(delete=False) as temp_file:
            temp_file.write(data)
            temp_file.flush()

            # Copy temporary file to container
            client.container.cp(temp_file.name, f"{container_id}:{container_path}")

        # Clean up temporary file
        os.unlink(temp_file.name)
        logger.info("Bytes data copy to container completed successfully")

    except Exception as e:
        logger.error(f"Copy bytes data to container failed: {e}")
        raise RuntimeError(f"Copy bytes data to container failed: {e}")


def copy_file_from_container(host_info: DockerHostInfo, container_id: str, container_path: str, host_path: str) -> None:
    """Copy file from container to host

    Args:
        host_info: Docker host information
        container_id: Container ID or name
        container_path: Path to file in container
        host_path: Destination path on host (including filename)
    """
    try:
        client = create_docker_client(host_info)
        logger.info(f"Copy file from container: {container_id} from path: {container_path} to host path: {host_path}")

        # Ensure directory exists
        os.makedirs(os.path.dirname(host_path), exist_ok=True)

        # Copy file from container
        client.container.cp(f"{container_id}:{container_path}", host_path)
        logger.info("File copy from container completed successfully")

    except Exception as e:
        logger.error(f"Copy file from container failed: {e}")
        raise RuntimeError(f"Copy file from container failed: {e}")


def execute_command_in_container(host_info: DockerHostInfo, container_id: str, command: Union[str, List[str]], 
                               user: Optional[str] = None, workdir: Optional[str] = None) -> Tuple[int, str]:
    """Execute command in container

    Args:
        host_info: Docker host information
        container_id: Container ID or name
        command: Command to execute
        user: User to run command as
        workdir: Working directory

    Returns:
        (exit_code, output)
    """
    try:
        client = create_docker_client(host_info)

        # Ensure command format
        if isinstance(command, str):
            # Use shlex.split to handle complex command strings with quotes and escapes
            import shlex
            command_list = shlex.split(command)
        else:
            command_list = command

        logger.info(f"Execute command in container {container_id}: {command_list}")

        result = client.container.execute(
            container_id, 
            command_list,
            user=user,
            workdir=workdir
        )

        logger.info(f"Command execution completed in container {container_id}")
        # python-on-whales returns string output, exit code is handled via exception
        return 0, result

    except Exception as e:
        logger.error(f"Command execution failed in container {container_id}: {e}")
        # If it's a command execution error, try to get exit code info
        exit_code = getattr(e, 'return_code', 1)
        output = str(e)
        return exit_code, output