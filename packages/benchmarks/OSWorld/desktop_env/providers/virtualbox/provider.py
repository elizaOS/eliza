import logging
import platform
import subprocess
import time
import os
from desktop_env.providers.base import Provider
import xml.etree.ElementTree as ET

logger = logging.getLogger("desktopenv.providers.virtualbox.VirtualBoxProvider")
logger.setLevel(logging.INFO)

WAIT_TIME = 3

# Note: Windows will not add command VBoxManage to PATH by default. Please add the folder where VBoxManage executable is in (Default should be "C:\Program Files\Oracle\VirtualBox" for Windows) to PATH.

class VirtualBoxProvider(Provider):
    @staticmethod
    def _execute_command(command: list):
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60, text=True,
                                encoding="utf-8")
        if result.returncode != 0:
            raise Exception("\033[91m" + result.stdout + result.stderr + "\033[0m")
        return result.stdout.strip()
    
    @staticmethod
    def _get_vm_uuid(path_to_vm: str):
        try:
            output = subprocess.check_output(f"VBoxManage list vms", shell=True, stderr=subprocess.STDOUT)
            output = output.decode()
            output = output.splitlines()
            if path_to_vm.endswith('.vbox'):
                # Load and parse the XML content from the file
                tree = ET.parse(path_to_vm)
                root = tree.getroot()
                
                # Find the <Machine> element and retrieve its 'uuid' attribute
                machine_element = root.find('.//{http://www.virtualbox.org/}Machine')
                if machine_element is not None:
                    uuid = machine_element.get('uuid')[1:-1]
                    return uuid
                else:
                    logger.error(f"UUID not found in file {path_to_vm}")
                    raise
            elif any(line.split()[1] == "{" + path_to_vm + "}" for line in output):
                logger.info(f"Got valid UUID {path_to_vm}.")
                return path_to_vm
            else:
                for line in output:
                    if line.split()[0] == '"' + path_to_vm + '"':
                        uuid = line.split()[1][1:-1]
                        return uuid
                logger.error(f"The path you provided does not match any of the \".vbox\" file, name, or UUID of VM.")
                raise
        except subprocess.CalledProcessError as e:
                logger.error(f"Error executing command: {e.output.decode().strip()}")
            

    def start_emulator(self, path_to_vm: str, headless: bool, os_type: str = None, *args, **kwargs):
        # Note: os_type parameter is ignored for VirtualBox provider
        # but kept for interface consistency with other providers
        logger.info("Starting VirtualBox VM...")

        while True:
            try:
                uuid = VirtualBoxProvider._get_vm_uuid(path_to_vm)
                output = subprocess.check_output(f"VBoxManage list runningvms", shell=True, stderr=subprocess.STDOUT)
                output = output.decode()
                output = output.splitlines()

                if any(line.split()[1] == "{" + uuid + "}" for line in output):
                    logger.info("VM is running.")
                    break
                else:
                    logger.info("Starting VM...")
                    VirtualBoxProvider._execute_command(["VBoxManage", "startvm", uuid]) if not headless else \
                    VirtualBoxProvider._execute_command(
                            ["VBoxManage", "startvm", uuid, "--type", "headless"])
                    time.sleep(WAIT_TIME)

            except subprocess.CalledProcessError as e:
                logger.error(f"Error executing command: {e.output.decode().strip()}")

    def get_ip_address(self, path_to_vm: str) -> str:
        logger.info("Getting VirtualBox VM IP address...")
        while True:
            try:
                uuid = VirtualBoxProvider._get_vm_uuid(path_to_vm)
                output = VirtualBoxProvider._execute_command(
                    ["VBoxManage", "guestproperty", "get", uuid, "/VirtualBox/GuestInfo/Net/0/V4/IP"]
                )
                result = output.split()[1]
                if result != "value":
                    logger.info(f"VirtualBox VM IP address: {result}")
                    return result
                else:
                    logger.error("VM IP address not found. Have you installed the guest additions?")
                    raise
            except Exception as e:
                logger.error(e)
                time.sleep(WAIT_TIME)
                logger.info("Retrying to get VirtualBox VM IP address...")

    def save_state(self, path_to_vm: str, snapshot_name: str):
        logger.info("Saving VirtualBox VM state...")
        uuid = VirtualBoxProvider._get_vm_uuid(path_to_vm)
        VirtualBoxProvider._execute_command(["VBoxManage", "snapshot", uuid, "take", snapshot_name])
        time.sleep(WAIT_TIME)  # Wait for the VM to save

    def revert_to_snapshot(self, path_to_vm: str, snapshot_name: str):
        logger.info(f"Reverting VirtualBox VM to snapshot: {snapshot_name}...")
        uuid = VirtualBoxProvider._get_vm_uuid(path_to_vm)
        VirtualBoxProvider._execute_command(["VBoxManage", "controlvm", uuid, "savestate"])
        time.sleep(WAIT_TIME)  # Wait for the VM to stop
        VirtualBoxProvider._execute_command(["VBoxManage", "snapshot", uuid, "restore", snapshot_name])
        time.sleep(WAIT_TIME)  # Wait for the VM to revert
        return path_to_vm

    def stop_emulator(self, path_to_vm: str, region=None, *args, **kwargs):
        # Note: region parameter is ignored for VirtualBox provider
        # but kept for interface consistency with other providers
        logger.info("Stopping VirtualBox VM...")
        uuid = VirtualBoxProvider._get_vm_uuid(path_to_vm)
        VirtualBoxProvider._execute_command(["VBoxManage", "controlvm", uuid, "savestate"])
        time.sleep(WAIT_TIME)  # Wait for the VM to stop
