import logging
import os
import platform
import shutil
import subprocess
import threading
import time
import zipfile

import psutil
import requests
from filelock import FileLock
from tqdm import tqdm

from desktop_env.providers.base import VMManager

logger = logging.getLogger("desktopenv.providers.virtualbox.VirtualBoxVMManager")
logger.setLevel(logging.INFO)

MAX_RETRY_TIMES = 10
RETRY_INTERVAL = 5
UBUNTU_ARM_URL = "NOT_AVAILABLE"
UBUNTU_X86_URL = "https://huggingface.co/datasets/xlangai/ubuntu_x86_virtualbox/resolve/main/Ubuntu.zip"
DOWNLOADED_FILE_NAME = "Ubuntu.zip"
REGISTRY_PATH = '.virtualbox_vms'

LOCK_FILE_NAME = '.virtualbox_lck'
VMS_DIR = "./virtualbox_vm_data"
update_lock = threading.Lock()

if platform.system() == 'Windows':
    vboxmanage_path = r"C:\Program Files\Oracle\VirtualBox"
    os.environ["PATH"] += os.pathsep + vboxmanage_path


def generate_new_vm_name(vms_dir, os_type):
    registry_idx = 0
    while True:
        attempted_new_name = f"{os_type}{registry_idx}"
        if os.path.exists(
                os.path.join(vms_dir, attempted_new_name, attempted_new_name, attempted_new_name + ".vbox")):
            registry_idx += 1
        else:
            return attempted_new_name


def _install_vm(vm_name, vms_dir, downloaded_file_name, original_vm_name="Ubuntu", bridged_adapter_name=None):
    os.makedirs(vms_dir, exist_ok=True)

    def __download_and_unzip_vm():
        # Determine the platform and CPU architecture to decide the correct VM image to download
        if platform.system() == 'Darwin':  # macOS
            url = UBUNTU_ARM_URL
            raise Exception("MacOS host is not currently supported for VirtualBox.")
        elif platform.machine().lower() in ['amd64', 'x86_64']:
            url = UBUNTU_X86_URL
        else:
            raise Exception("Unsupported platform or architecture.")

        # Check for HF_ENDPOINT environment variable and replace domain if set to hf-mirror.com
        hf_endpoint = os.environ.get('HF_ENDPOINT')
        if hf_endpoint and 'hf-mirror.com' in hf_endpoint:
            url = url.replace('huggingface.co', 'hf-mirror.com')
            logger.info(f"Using HF mirror: {url}")

        # Download the virtual machine image
        logger.info("Downloading the virtual machine image...")
        downloaded_size = 0

        while True:
            downloaded_file_path = os.path.join(vms_dir, downloaded_file_name)
            headers = {}
            if os.path.exists(downloaded_file_path):
                downloaded_size = os.path.getsize(downloaded_file_path)
                headers["Range"] = f"bytes={downloaded_size}-"

            with requests.get(url, headers=headers, stream=True) as response:
                if response.status_code == 416:
                    # This means the range was not satisfiable, possibly the file was fully downloaded
                    logger.info("Fully downloaded or the file size changed.")
                    break

                response.raise_for_status()
                total_size = int(response.headers.get('content-length', 0))

                with open(downloaded_file_path, "ab") as file, tqdm(
                        desc="Progress",
                        total=total_size,
                        unit='iB',
                        unit_scale=True,
                        unit_divisor=1024,
                        initial=downloaded_size,
                        ascii=True
                ) as progress_bar:
                    try:
                        for data in response.iter_content(chunk_size=1024):
                            size = file.write(data)
                            progress_bar.update(size)
                    except (requests.exceptions.RequestException, IOError) as e:
                        logger.error(f"Download error: {e}")
                        time.sleep(RETRY_INTERVAL)
                        logger.error("Retrying...")
                    else:
                        logger.info("Download succeeds.")
                        break  # Download completed successfully

        # Unzip the downloaded file
        logger.info("Unzipping the downloaded file...☕️")
        with zipfile.ZipFile(downloaded_file_path, 'r') as zip_ref:
            zip_ref.extractall(vms_dir)
        logger.info("Files have been successfully extracted to the directory: " + vms_dir)

    def import_vm(vms_dir, target_vm_name, max_retries=1):
        """Import the .ovf file into VirtualBox."""
        logger.info(f"Starting to import VM {target_vm_name}...")
        command = (
            f"VBoxManage import {os.path.abspath(os.path.join(vms_dir, original_vm_name, original_vm_name + '.ovf'))} "
            f"--vsys 0 "
            f"--vmname {target_vm_name} "
            f"--settingsfile {os.path.abspath(os.path.join(vms_dir, target_vm_name, target_vm_name + '.vbox'))} "
            f"--basefolder {vms_dir} "
            f"--unit 14 "
            f"--disk {os.path.abspath(os.path.join(vms_dir, target_vm_name, target_vm_name + '_disk1.vmdk'))}")

        for attempt in range(max_retries):
            result = subprocess.run(command, shell=True, text=True, capture_output=True, encoding="utf-8",
                                    errors='ignore')
            if result.returncode == 0:
                logger.info("Successfully imported VM.")
                return True
            else:
                if not result.stderr or "Error" in result.stderr:
                    logger.error(f"Attempt {attempt + 1} failed with specific error: {result.stderr}")
                else:
                    logger.error(f"Attempt {attempt + 1} failed: {result.stderr}")

                if attempt == max_retries - 1:
                    logger.error("Maximum retry attempts reached, failed to import the virtual machine.")
                    return False
                
    def configure_vm_network(vm_name, interface_name=None):
        # Config of bridged network
        command = f'VBoxManage modifyvm "{vm_name}" --nic1 bridged'
        result = subprocess.run(command, shell=True, text=True, capture_output=True, encoding="utf-8",
                                    errors='ignore')
        if not interface_name:
            output = subprocess.check_output(f"VBoxManage list bridgedifs", shell=True, stderr=subprocess.STDOUT)
            output = output.decode()
            output = output.splitlines()
            result = []
            for line in output:
                entries = line.split()
                if entries and entries[0] == "Name:":
                    name = ' '.join(entries[1:])
                if entries and entries[0] == "IPAddress:":
                    ip = entries[1]
                    result.append((name, ip))
            logger.info("Found the following network adapters, default to the first. If you want to change it, please set the argument -r to the name of the adapter.")
            for i, (name, ip) in enumerate(result):
                logger.info(f"{i+1}: {name} ({ip})")
            interface_id = 1
            interface_name = result[interface_id-1][0]
        command = f'vboxmanage modifyvm "{vm_name}" --bridgeadapter1 "{interface_name}"'
        result = subprocess.run(command, shell=True, text=True, capture_output=True, encoding="utf-8",
                                    errors='ignore')
        if result.returncode == 0:
            logger.info(f"Changed to bridge adapter {interface_name}.")
            return True
        else:
            logger.error(f"Failed to change to bridge adapter {interface_name}: {result.stderr}")
            return False
        
        # # Config of NAT network
        # command = f"VBoxManage natnetwork add --netname natnet --network {nat_network} --dhcp on"
        # result = subprocess.run(command, shell=True, text=True, capture_output=True, encoding="utf-8",
        #                             errors='ignore')
        # if result.returncode == 0:
        #     logger.info(f"Created NAT network {nat_network}.")
        # else:
        #     logger.error(f"Failed to create NAT network {nat_network}")
        #     return False
        # command = f"VBoxManage modifyvm {vm_name} --nic1 natnetwork"
        # result = subprocess.run(command, shell=True, text=True, capture_output=True, encoding="utf-8",
        #                             errors='ignore')
        # command = f"VBoxManage modifyvm {vm_name} --natnet1 natnet"
        # result = subprocess.run(command, shell=True, text=True, capture_output=True, encoding="utf-8",
        #                             errors='ignore')
        # if result.returncode == 0:
        #     logger.info("Switched VM to the NAT network.")
        # else:
        #     logger.error("Failed to switch VM to the NAT network")
        #     return False
        # logger.info("Start to configure port forwarding...")
        # command = f"VBoxManage modifyvm {vm_name} --natpf1 'server,tcp,,5000,,5000'"
        # result = subprocess.run(command, shell=True, text=True, capture_output=True, encoding="utf-8",
        #                     errors='ignore')
        # if result.returncode == 0:
        #     logger.info("Successfully created port forwarding rule.")
        #     return True
        # logger.error("Failed to create port forwarding rule.")
        # return False


    vm_path = os.path.join(vms_dir, vm_name, vm_name + ".vbox")

    # Execute the function to download and unzip the VM, and update the vm metadata
    if not os.path.exists(vm_path):
        __download_and_unzip_vm()
        import_vm(vms_dir, vm_name)
        if not configure_vm_network(vm_name, bridged_adapter_name):
            raise Exception("Failed to configure VM network!")
    else:
        logger.info(f"Virtual machine exists: {vm_path}")

    # Start the virtual machine
    def start_vm(vm_name, max_retries=20):
        command = f'VBoxManage startvm "{vm_name}" --type headless'

        for attempt in range(max_retries):
            result = subprocess.run(command, shell=True, text=True, capture_output=True, encoding="utf-8")
            if result.returncode == 0:
                logger.info("Virtual machine started.")
                return True
            else:
                if not result.stderr or "Error" in result.stderr:
                    logger.error(f"Attempt {attempt + 1} failed with specific error: {result.stderr}")
                else:
                    logger.error(f"Attempt {attempt + 1} failed: {result.stderr}")

                if attempt == max_retries - 1:
                    logger.error("Maximum retry attempts reached, failed to start the virtual machine.")
                    return False

    if not start_vm(vm_name):
        raise ValueError("Error encountered during installation, please rerun the code for retrying.")

    def get_vm_ip(vm_name):
        command = f'VBoxManage guestproperty get "{vm_name}" /VirtualBox/GuestInfo/Net/0/V4/IP'
        result = subprocess.run(command, shell=True, text=True, capture_output=True, encoding="utf-8")
        if result.returncode == 0:
            return result.stdout.strip().split()[1]
        else:
            logger.error(f"Get VM IP failed: {result.stderr}")
            return None
        
    def change_resolution(vm_name, resolution=(1920, 1080, 32)):
        command = f'VBoxManage controlvm "{vm_name}" setvideomodehint {" ".join(map(str, resolution))}'
        result = subprocess.run(command, shell=True, text=True, capture_output=True, encoding="utf-8")
        if result.returncode == 0:
            return True
        else:
            return False

    # Function used to check whether the virtual machine is ready
    def download_screenshot(vm_name):
        ip = get_vm_ip(vm_name)
        url = f"http://{ip}:5000/screenshot"
        try:
            # max trey times 1, max timeout 1
            response = requests.get(url, timeout=(10, 10))
            if response.status_code == 200:
                return True
        except Exception as e:
            logger.error(f"Error: {e}")
            logger.error(f"Type: {type(e).__name__}")
            logger.error(f"Error detail: {str(e)}")
        return False

    # Try downloading the screenshot until successful
    while not download_screenshot(vm_name):
        logger.info("Check whether the virtual machine is ready...")
        time.sleep(RETRY_INTERVAL)

    if not change_resolution(vm_name):
        logger.error(f"Change resolution failed.")
        raise

    logger.info("Virtual machine is ready. Start to make a snapshot on the virtual machine. It would take a while...")

    def create_vm_snapshot(vm_name, max_retries=20):
        logger.info("Saving VirtualBox VM state...")
        command = f'VBoxManage snapshot "{vm_name}" take init_state'

        for attempt in range(max_retries):
            result = subprocess.run(command, shell=True, text=True, capture_output=True, encoding="utf-8")
            if result.returncode == 0:
                logger.info("Snapshot created.")
                return True
            else:
                if "Error" in result.stderr:
                    logger.error(f"Attempt {attempt + 1} failed with specific error: {result.stderr}")
                else:
                    logger.error(f"Attempt {attempt + 1} failed: {result.stderr}")

                if attempt == max_retries - 1:
                    logger.error("Maximum retry attempts reached, failed to create snapshot.")
                    return False

    # Create a snapshot of the virtual machine
    if create_vm_snapshot(vm_name, max_retries=MAX_RETRY_TIMES):
        return vm_path
    else:
        raise ValueError("Error encountered during installation, please rerun the code for retrying.")


class VirtualBoxVMManager(VMManager):
    def __init__(self, registry_path=REGISTRY_PATH):
        self.registry_path = registry_path
        self.lock = FileLock(LOCK_FILE_NAME, timeout=60)
        self.initialize_registry()

    def initialize_registry(self):
        with self.lock:  # Locking during initialization
            if not os.path.exists(self.registry_path):
                with open(self.registry_path, 'w') as file:
                    file.write('')

    def add_vm(self, vm_path, lock_needed=True):
        if lock_needed:
            with self.lock:
                self._add_vm(vm_path)
        else:
            self._add_vm(vm_path)

    def _add_vm(self, vm_path, region=None):
        assert region in [None, 'local'], "For VirtualBox provider, the region should be neither None or 'local'."
        with self.lock:
            with open(self.registry_path, 'r') as file:
                lines = file.readlines()
                new_lines = lines + [f'{vm_path}|free\n']
            with open(self.registry_path, 'w') as file:
                file.writelines(new_lines)

    def occupy_vm(self, vm_path, pid, lock_needed=True):
        if lock_needed:
            with self.lock:
                self._occupy_vm(vm_path, pid)
        else:
            self._occupy_vm(vm_path, pid)

    def _occupy_vm(self, vm_path, pid, region=None):
        assert region in [None, 'local'], "For VirtualBox provider, the region should be neither None or 'local'."
        with self.lock:
            new_lines = []
            with open(self.registry_path, 'r') as file:
                lines = file.readlines()
                for line in lines:
                    registered_vm_path, _ = line.strip().split('|')
                    if registered_vm_path == vm_path:
                        new_lines.append(f'{registered_vm_path}|{pid}\n')
                    else:
                        new_lines.append(line)
            with open(self.registry_path, 'w') as file:
                file.writelines(new_lines)

    def delete_vm(self, vm_path, lock_needed=True):
        if lock_needed:
            with self.lock:
                self._delete_vm(vm_path)
        else:
            self._delete_vm(vm_path)

    def _delete_vm(self, vm_path):
        raise NotImplementedError

    def check_and_clean(self, vms_dir, lock_needed=True):
        if lock_needed:
            with self.lock:
                self._check_and_clean(vms_dir)
        else:
            self._check_and_clean(vms_dir)

    def _check_and_clean(self, vms_dir):
        with self.lock:  # Lock when cleaning up the registry and vms_dir
            # Check and clean on the running vms, detect the released ones and mark then as 'free'
            active_pids = {p.pid for p in psutil.process_iter()}
            new_lines = []
            vm_paths = []

            with open(self.registry_path, 'r') as file:
                lines = file.readlines()
                for line in lines:
                    vm_path, pid_str = line.strip().split('|')
                    if not os.path.exists(vm_path):
                        logger.info(f"VM {vm_path} not found, releasing it.")
                        new_lines.append(f'{vm_path}|free\n')
                        continue

                    vm_paths.append(vm_path)
                    if pid_str == "free":
                        new_lines.append(line)
                        continue

                    if int(pid_str) in active_pids:
                        new_lines.append(line)
                    else:
                        new_lines.append(f'{vm_path}|free\n')
            with open(self.registry_path, 'w') as file:
                file.writelines(new_lines)

            # Check and clean on the files inside vms_dir, delete the unregistered ones
            os.makedirs(vms_dir, exist_ok=True)
            vm_names = os.listdir(vms_dir)
            for vm_name in vm_names:
                # skip the downloaded .zip file
                if vm_name == DOWNLOADED_FILE_NAME:
                    continue
                # Skip the .DS_Store file on macOS
                if vm_name == ".DS_Store":
                    continue

                flag = True
                for vm_path in vm_paths:
                    if vm_name + ".vbox" in vm_path:
                        flag = False
                if flag:
                    shutil.rmtree(os.path.join(vms_dir, vm_name))

    def list_free_vms(self, lock_needed=True):
        if lock_needed:
            with self.lock:
                return self._list_free_vms()
        else:
            return self._list_free_vms()

    def _list_free_vms(self):
        with self.lock:  # Lock when reading the registry
            free_vms = []
            with open(self.registry_path, 'r') as file:
                lines = file.readlines()
                for line in lines:
                    vm_path, pid_str = line.strip().split('|')
                    if pid_str == "free":
                        free_vms.append((vm_path, pid_str))
            return free_vms

    def get_vm_path(self, os_type, region=None, screen_size=(1920, 1080), **kwargs):
        # Note: screen_size parameter is ignored for VirtualBox provider
        # but kept for interface consistency with other providers
        if os_type != "Ubuntu":
            raise ValueError("Only support Ubuntu for now.")

        with self.lock:
            if not VirtualBoxVMManager.checked_and_cleaned:
                VirtualBoxVMManager.checked_and_cleaned = True
                self._check_and_clean(vms_dir=VMS_DIR)

        allocation_needed = False
        with self.lock:
            free_vms_paths = self._list_free_vms()
            if len(free_vms_paths) == 0:
                # No free virtual machine available, generate a new one
                allocation_needed = True
            else:
                # Choose the first free virtual machine
                chosen_vm_path = free_vms_paths[0][0]
                self._occupy_vm(chosen_vm_path, os.getpid())
                return chosen_vm_path
            
        if allocation_needed:
            logger.info("No free virtual machine available. Generating a new one, which would take a while...☕")
            new_vm_name = generate_new_vm_name(vms_dir=VMS_DIR, os_type=os_type)
            new_vm_path = _install_vm(new_vm_name, vms_dir=VMS_DIR,
                                    downloaded_file_name=DOWNLOADED_FILE_NAME,
                                    bridged_adapter_name=region)
            with self.lock:
                self._add_vm(new_vm_path)
                self._occupy_vm(new_vm_path, os.getpid())
            return new_vm_path
