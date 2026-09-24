import os
import platform
import zipfile

from time import sleep
import requests
from tqdm import tqdm

import logging

from desktop_env.providers.base import VMManager

logger = logging.getLogger("desktopenv.providers.docker.DockerVMManager")
logger.setLevel(logging.INFO)

MAX_RETRY_TIMES = 10
RETRY_INTERVAL = 5

UBUNTU_X86_URL = "https://huggingface.co/datasets/xlangai/ubuntu_osworld/resolve/main/Ubuntu.qcow2.zip"
WINDOWS_X86_URL = "https://huggingface.co/datasets/xlangai/windows_osworld/resolve/main/Windows-10-x64.qcow2.zip"
VMS_DIR = "./docker_vm_data"

URL = UBUNTU_X86_URL
DOWNLOADED_FILE_NAME = URL.split('/')[-1]

if platform.system() == 'Windows':
    docker_path = r"C:\Program Files\Docker\Docker"
    os.environ["PATH"] += os.pathsep + docker_path


def _download_vm(vms_dir: str):
    global URL, DOWNLOADED_FILE_NAME
    # Download the virtual machine image
    logger.info("Downloading the virtual machine image...")
    downloaded_size = 0

    # Check for HF_ENDPOINT environment variable and replace domain if set to hf-mirror.com
    hf_endpoint = os.environ.get('HF_ENDPOINT')
    if hf_endpoint and 'hf-mirror.com' in hf_endpoint:
        URL = URL.replace('huggingface.co', 'hf-mirror.com')
        logger.info(f"Using HF mirror: {URL}")

    downloaded_file_name = DOWNLOADED_FILE_NAME

    os.makedirs(vms_dir, exist_ok=True)

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

    if downloaded_file_name.endswith(".zip"):
        # Unzip the downloaded file
        logger.info("Unzipping the downloaded file...☕️")
        with zipfile.ZipFile(downloaded_file_path, 'r') as zip_ref:
            zip_ref.extractall(vms_dir)
        logger.info("Files have been successfully extracted to the directory: " + str(vms_dir))


class DockerVMManager(VMManager):
    def __init__(self, registry_path=""):
        pass

    def add_vm(self, vm_path):
        pass

    def check_and_clean(self):
        pass

    def delete_vm(self, vm_path, region=None, **kwargs):
        # Fixed: Added region and **kwargs parameters for interface compatibility
        pass

    def initialize_registry(self):
        pass

    def list_free_vms(self):
        return os.path.join(VMS_DIR, DOWNLOADED_FILE_NAME)

    def occupy_vm(self, vm_path, pid, region=None, **kwargs):
        # Fixed: Added pid, region and **kwargs parameters for interface compatibility
        pass

    def get_vm_path(self, os_type, region, screen_size=(1920, 1080), **kwargs):
        # Note: screen_size parameter is ignored for Docker provider
        # but kept for interface consistency with other providers
        global URL, DOWNLOADED_FILE_NAME
        if os_type == "Ubuntu":
            URL = UBUNTU_X86_URL
        elif os_type == "Windows":
            URL = WINDOWS_X86_URL
        
        # Check for HF_ENDPOINT environment variable and replace domain if set to hf-mirror.com
        hf_endpoint = os.environ.get('HF_ENDPOINT')
        if hf_endpoint and 'hf-mirror.com' in hf_endpoint:
            URL = URL.replace('huggingface.co', 'hf-mirror.com')
            logger.info(f"Using HF mirror: {URL}")
            
        DOWNLOADED_FILE_NAME = URL.split('/')[-1]

        if DOWNLOADED_FILE_NAME.endswith(".zip"):
            vm_name = DOWNLOADED_FILE_NAME[:-4]
        else:
            vm_name = DOWNLOADED_FILE_NAME

        if not os.path.exists(os.path.join(VMS_DIR, vm_name)):
            _download_vm(VMS_DIR)
        return os.path.join(VMS_DIR, vm_name)
