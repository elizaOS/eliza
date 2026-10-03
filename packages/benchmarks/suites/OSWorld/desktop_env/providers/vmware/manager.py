import os
import platform
import random
import re

import threading
from filelock import FileLock
import uuid
import zipfile

from time import sleep
import shutil
import psutil
import subprocess
import requests
from tqdm import tqdm

import logging

from desktop_env.providers.base import VMManager

logger = logging.getLogger("desktopenv.providers.vmware.VMwareVMManager")
logger.setLevel(logging.INFO)

MAX_RETRY_TIMES = 10
RETRY_INTERVAL = 5
UBUNTU_ARM_URL = "https://huggingface.co/datasets/xlangai/ubuntu_osworld/resolve/main/Ubuntu-arm.zip"
UBUNTU_X86_URL = "https://huggingface.co/datasets/xlangai/ubuntu_osworld/resolve/main/Ubuntu-x86.zip"
WINDOWS_X86_URL = "https://huggingface.co/datasets/xlangai/windows_osworld/resolve/main/Windows-x86.zip"

# Determine the platform and CPU architecture to decide the correct VM image to download
# sometimes the system is 'Darwin' but the machine is x86-based.​​ 
if platform.machine().lower() in ['amd64', 'x86_64']:
    URL = UBUNTU_X86_URL
elif platform.system() == 'Darwin':  # macOS
    URL = UBUNTU_ARM_URL
else:
    raise Exception("Unsupported platform or architecture")

DOWNLOADED_FILE_NAME = URL.split('/')[-1]
REGISTRY_PATH = '.vmware_vms'
LOCK_FILE_NAME = '.vmware_lck'
VMS_DIR = "./vmware_vm_data"
update_lock = threading.Lock()

if platform.system() == 'Windows':
    vboxmanage_path = r"C:\Program Files (x86)\VMware\VMware Workstation"
    os.environ["PATH"] += os.pathsep + vboxmanage_path

def generate_new_vm_name(vms_dir, os_type):
    registry_idx = 0
    prefix = os_type
    while True:
        attempted_new_name = f"{prefix}{registry_idx}"
        if os.path.exists(
                os.path.join(vms_dir, attempted_new_name, attempted_new_name + ".vmx")):
            registry_idx += 1
        else:
            return attempted_new_name


def _update_vm(vmx_path, target_vm_name):
    """Update the VMX file with the new VM name and other parameters, so that the VM can be started successfully without conflict with the original VM."""
    with update_lock:
        dir_path, vmx_file = os.path.split(vmx_path)

        def _generate_mac_address():
            # VMware MAC address range starts with 00:0c:29
            mac = [0x00, 0x0c, 0x29,
                   random.randint(0x00, 0x7f),
                   random.randint(0x00, 0xff),
                   random.randint(0x00, 0xff)]
            return ':'.join(map(lambda x: "%02x" % x, mac))

        # Backup the original file
        with open(vmx_path, 'r') as file:
            original_content = file.read()

        # Generate new values
        new_uuid_bios = str(uuid.uuid4())
        new_uuid_location = str(uuid.uuid4())
        new_mac_address = _generate_mac_address()
        new_vmci_id = str(random.randint(-2147483648, 2147483647))  # Random 32-bit integer

        # Update the content
        updated_content = re.sub(r'displayName = ".*?"', f'displayName = "{target_vm_name}"', original_content)
        updated_content = re.sub(r'uuid.bios = ".*?"', f'uuid.bios = "{new_uuid_bios}"', updated_content)
        updated_content = re.sub(r'uuid.location = ".*?"', f'uuid.location = "{new_uuid_location}"', updated_content)
        updated_content = re.sub(r'ethernet0.generatedAddress = ".*?"',
                                 f'ethernet0.generatedAddress = "{new_mac_address}"',
                                 updated_content)
        updated_content = re.sub(r'vmci0.id = ".*?"', f'vmci0.id = "{new_vmci_id}"', updated_content)

        # Write the updated content back to the file
        with open(vmx_path, 'w') as file:
            file.write(updated_content)

        logger.info(".vmx file updated successfully.")

        vmx_file_base_name = os.path.splitext(vmx_file)[0]

        files_to_rename = ['vmx', 'nvram', 'vmsd', 'vmxf']

        for ext in files_to_rename:
            original_file = os.path.join(dir_path, f"{vmx_file_base_name}.{ext}")
            target_file = os.path.join(dir_path, f"{target_vm_name}.{ext}")
            os.rename(original_file, target_file)

        # Update the dir_path to the target vm_name, only replace the last character
        # Split the path into parts up to the last folder
        path_parts = dir_path.rstrip(os.sep).split(os.sep)
        path_parts[-1] = target_vm_name
        target_dir_path = os.sep.join(path_parts)
        os.rename(dir_path, target_dir_path)

        logger.info("VM files renamed successfully.")


def _install_vm(vm_name, vms_dir, downloaded_file_name, os_type, original_vm_name="Ubuntu"):
    os.makedirs(vms_dir, exist_ok=True)

    def __download_and_unzip_vm():
        # Download the virtual machine image
        logger.info("Downloading the virtual machine image...")
        downloaded_size = 0
        # sometimes the system is 'Darwin' but the machine is x86-based.​​ 
        if os_type == "Ubuntu":
            if platform.machine().lower() in ['amd64', 'x86_64']:
                URL = UBUNTU_X86_URL
            elif platform.system() == 'Darwin':
                URL = UBUNTU_ARM_URL
        elif os_type == "Windows":
            if platform.machine().lower() in ['amd64', 'x86_64']:
                URL = WINDOWS_X86_URL
        
        # Check for HF_ENDPOINT environment variable and replace domain if set to hf-mirror.com
        hf_endpoint = os.environ.get('HF_ENDPOINT')
        if hf_endpoint and 'hf-mirror.com' in hf_endpoint:
            URL = URL.replace('huggingface.co', 'hf-mirror.com')
            logger.info(f"Using HF mirror: {URL}")
        
        DOWNLOADED_FILE_NAME = URL.split('/')[-1]
        downloaded_file_name = DOWNLOADED_FILE_NAME

        while True:
            downloaded_file_path = os.path.join(vms_dir, downloaded_file_name)
            headers = {}
            if os.path.exists(downloaded_file_path):
                downloaded_size = os.path.getsize(downloaded_file_path)
                headers["Range"] = f"bytes={downloaded_size}-"

            with requests.get(URL, headers=headers, stream=True) as response:
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
                        sleep(RETRY_INTERVAL)
                        logger.error("Retrying...")
                    else:
                        logger.info("Download succeeds.")
                        break  # Download completed successfully

        # Unzip the downloaded file
        logger.info("Unzipping the downloaded file...☕️")
        with zipfile.ZipFile(downloaded_file_path, 'r') as zip_ref:
            zip_ref.extractall(os.path.join(vms_dir, vm_name))
        logger.info("Files have been successfully extracted to the directory: " + str(os.path.join(vms_dir, vm_name)))

    vm_path = os.path.join(vms_dir, vm_name, vm_name + ".vmx")

    # Execute the function to download and unzip the VM, and update the vm metadata
    if not os.path.exists(vm_path):
        __download_and_unzip_vm()
        _update_vm(os.path.join(vms_dir, vm_name, original_vm_name + ".vmx"), vm_name)
    else:
        logger.info(f"Virtual machine exists: {vm_path}")

    # Determine the platform of the host machine and decide the parameter for vmrun
    def get_vmrun_type():
        if platform.system() == 'Windows' or platform.system() == 'Linux':
            return '-T ws'
        elif platform.system() == 'Darwin':  # Darwin is the system name for macOS
            return '-T fusion'
        else:
            raise Exception("Unsupported operating system")

    # Start the virtual machine
    def start_vm(vm_path, max_retries=20):
        command = f'vmrun {get_vmrun_type()} start "{vm_path}" nogui'
        for attempt in range(max_retries):
            result = subprocess.run(command, shell=True, text=True, capture_output=True, encoding="utf-8")
            if result.returncode == 0:
                logger.info("Virtual machine started.")
                return True
            else:
                if "Error" in result.stderr:
                    logger.error(f"Attempt {attempt + 1} failed with specific error: {result.stderr}")
                else:
                    logger.error(f"Attempt {attempt + 1} failed: {result.stderr}")

                if attempt == max_retries - 1:
                    logger.error("Maximum retry attempts reached, failed to start the virtual machine.")
                    return False

    if not start_vm(vm_path):
        raise ValueError("Error encountered during installation, please rerun the code for retrying.")

    def get_vm_ip(vm_path, max_retries=20):
        command = f'vmrun {get_vmrun_type()} getGuestIPAddress "{vm_path}" -wait'
        for attempt in range(max_retries):
            result = subprocess.run(command, shell=True, text=True, capture_output=True, encoding="utf-8")
            if result.returncode == 0:
                return result.stdout.strip()
            else:
                if "Error" in result.stderr:
                    logger.error(f"Attempt {attempt + 1} failed with specific error: {result.stderr}")
                else:
                    logger.error(f"Attempt {attempt + 1} failed: {result.stderr}")

                if attempt == max_retries - 1:
                    logger.error("Maximum retry attempts reached, failed to get the IP of virtual machine.")
                    return None

    vm_ip = get_vm_ip(vm_path)
    if not vm_ip:
        raise ValueError("Error encountered during installation, please rerun the code for retrying.")

    # Function used to check whether the virtual machine is ready
    def download_screenshot(ip):
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
            sleep(RETRY_INTERVAL)
        return False

    # Try downloading the screenshot until successful
    while not download_screenshot(vm_ip):
        # Try to get the IP again in case it has changed
        vm_ip = get_vm_ip(vm_path)
        logger.info("Check whether the virtual machine is ready...")

    logger.info("Virtual machine is ready. Start to make a snapshot on the virtual machine. It would take a while...")

    def create_vm_snapshot(vm_path, max_retries=20):
        command = f'vmrun {get_vmrun_type()} snapshot "{vm_path}" "init_state"'
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
    if create_vm_snapshot(vm_path, max_retries=MAX_RETRY_TIMES):
        return vm_path
    else:
        raise ValueError("Error encountered during installation, please rerun the code for retrying.")


class VMwareVMManager(VMManager):
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
        assert region in [None, 'local'], "For VMware provider, the region should be neither None or 'local'."
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
        assert region in [None, 'local'], "For VMware provider, the region should be neither None or 'local'."
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
                    if vm_name + ".vmx" in vm_path:
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
        # Note: screen_size parameter is ignored for VMware provider
        # but kept for interface consistency with other providers
        with self.lock:
            if not VMwareVMManager.checked_and_cleaned:
                VMwareVMManager.checked_and_cleaned = True
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

            original_vm_name = None
            if os_type == "Ubuntu":
                original_vm_name = "Ubuntu"
            elif os_type == "Windows":
                original_vm_name = "Windows 10 x64"

            new_vm_path = _install_vm(new_vm_name, vms_dir=VMS_DIR,
                                    downloaded_file_name=DOWNLOADED_FILE_NAME, original_vm_name=original_vm_name, os_type=os_type)
            with self.lock:
                self._add_vm(new_vm_path)
                self._occupy_vm(new_vm_path, os.getpid())
            return new_vm_path
