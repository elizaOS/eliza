import os
import threading
import boto3
import psutil

import logging

from desktop_env.providers.base import VMManager

logger = logging.getLogger("desktopenv.providers.azure.AzureVMManager")
logger.setLevel(logging.INFO)

REGISTRY_PATH = '.azure_vms'


def _allocate_vm(region):
    raise NotImplementedError


class AzureVMManager(VMManager):
    def __init__(self, registry_path=REGISTRY_PATH):
        self.registry_path = registry_path
        self.lock = threading.Lock()
        self.initialize_registry()

    def initialize_registry(self):
        with self.lock:  # Locking during initialization
            if not os.path.exists(self.registry_path):
                with open(self.registry_path, 'w') as file:
                    file.write('')

    def add_vm(self, vm_path, region):
        with self.lock:
            with open(self.registry_path, 'r') as file:
                lines = file.readlines()
                vm_path_at_vm_region = "{}@{}".format(vm_path, region)
                new_lines = lines + [f'{vm_path_at_vm_region}|free\n']
            with open(self.registry_path, 'w') as file:
                file.writelines(new_lines)

    def occupy_vm(self, vm_path, pid, region):
        with self.lock:
            new_lines = []
            with open(self.registry_path, 'r') as file:
                lines = file.readlines()
                for line in lines:
                    registered_vm_path, _ = line.strip().split('|')
                    if registered_vm_path == "{}@{}".format(vm_path, region):
                        new_lines.append(f'{registered_vm_path}|{pid}\n')
                    else:
                        new_lines.append(line)
            with open(self.registry_path, 'w') as file:
                file.writelines(new_lines)

    def check_and_clean(self):
        raise NotImplementedError

    def list_free_vms(self, region):
        with self.lock:  # Lock when reading the registry
            free_vms = []
            with open(self.registry_path, 'r') as file:
                lines = file.readlines()
                for line in lines:
                    vm_path_at_vm_region, pid_str = line.strip().split('|')
                    vm_path, vm_region = vm_path_at_vm_region.split("@")
                    if pid_str == "free" and vm_region == region:
                        free_vms.append((vm_path, pid_str))
            return free_vms

    def get_vm_path(self, region, screen_size=(1920, 1080), **kwargs):
        # Note: screen_size parameter is ignored for Azure provider
        # but kept for interface consistency with other providers
        self.check_and_clean()
        free_vms_paths = self.list_free_vms(region)
        if len(free_vms_paths) == 0:
            # No free virtual machine available, generate a new one
            logger.info("No free virtual machine available. Generating a new one, which would take a while...☕")
            new_vm_path = _allocate_vm(region)
            self.add_vm(new_vm_path, region)
            self.occupy_vm(new_vm_path, os.getpid(), region)
            return new_vm_path
        else:
            # Choose the first free virtual machine
            chosen_vm_path = free_vms_paths[0][0]
            self.occupy_vm(chosen_vm_path, os.getpid(), region)
            return chosen_vm_path

