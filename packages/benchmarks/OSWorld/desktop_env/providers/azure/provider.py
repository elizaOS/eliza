import os
import time
from azure.identity import DefaultAzureCredential
from azure.mgmt.compute import ComputeManagementClient
from azure.mgmt.network import NetworkManagementClient
from azure.core.exceptions import ResourceNotFoundError

import logging

from desktop_env.providers.base import Provider

logger = logging.getLogger("desktopenv.providers.azure.AzureProvider")
logger.setLevel(logging.INFO)

WAIT_DELAY = 15
MAX_ATTEMPTS = 10

# To use the Azure provider, download azure-cli by https://learn.microsoft.com/en-us/cli/azure/install-azure-cli,
# use "az login" to log into you Azure account,
# and set environment variable "AZURE_SUBSCRIPTION_ID" to your subscription ID.
# Provide your resource group name and VM name in the format "RESOURCE_GROUP_NAME/VM_NAME" and pass as an argument for "-p".

class AzureProvider(Provider):
    def __init__(self, region: str = None):
        super().__init__(region)
        credential = DefaultAzureCredential()
        try:
            self.subscription_id = os.environ["AZURE_SUBSCRIPTION_ID"]
        except:
            logger.error("Azure subscription ID not found. Please set environment variable \"AZURE_SUBSCRIPTION_ID\".")
            raise
        self.compute_client = ComputeManagementClient(credential, self.subscription_id)
        self.network_client = NetworkManagementClient(credential, self.subscription_id)

    def start_emulator(self, path_to_vm: str, headless: bool, os_type: str = None, *args, **kwargs):
        # Note: os_type parameter is ignored for Azure provider
        # but kept for interface consistency with other providers
        logger.info("Starting Azure VM...")
        resource_group_name, vm_name = path_to_vm.split('/')

        vm = self.compute_client.virtual_machines.get(resource_group_name, vm_name, expand='instanceView')
        power_state = vm.instance_view.statuses[-1].code
        if power_state == "PowerState/running":
            logger.info("VM is already running.")
            return
        
        try:
            # Start the instance
            for _ in range(MAX_ATTEMPTS):
                async_vm_start = self.compute_client.virtual_machines.begin_start(resource_group_name, vm_name)
                logger.info(f"VM {path_to_vm} is starting...")
                # Wait for the instance to start
                async_vm_start.wait(timeout=WAIT_DELAY)
                vm = self.compute_client.virtual_machines.get(resource_group_name, vm_name, expand='instanceView')
                power_state = vm.instance_view.statuses[-1].code
                if power_state == "PowerState/running":
                    logger.info(f"VM {path_to_vm} is already running.")
                    break
        except Exception as e:
            logger.error(f"Failed to start the Azure VM {path_to_vm}: {str(e)}")
            raise

    def get_ip_address(self, path_to_vm: str) -> str:
        logger.info("Getting Azure VM IP address...")
        resource_group_name, vm_name = path_to_vm.split('/')

        vm = self.compute_client.virtual_machines.get(resource_group_name, vm_name)

        for interface in vm.network_profile.network_interfaces:
            name=" ".join(interface.id.split('/')[-1:])
            sub="".join(interface.id.split('/')[4])

            try:
                thing=self.network_client.network_interfaces.get(sub, name).ip_configurations

                network_card_id = thing[0].public_ip_address.id.split('/')[-1]
                public_ip_address = self.network_client.public_ip_addresses.get(resource_group_name, network_card_id)
                logger.info(f"VM IP address is {public_ip_address.ip_address}")
                return public_ip_address.ip_address

            except Exception as e:
                logger.error(f"Cannot get public IP for VM {path_to_vm}")
                raise

    def save_state(self, path_to_vm: str, snapshot_name: str):
        print("Saving Azure VM state...")
        resource_group_name, vm_name = path_to_vm.split('/')

        vm = self.compute_client.virtual_machines.get(resource_group_name, vm_name)

        try:
            # Backup each disk attached to the VM
            for disk in vm.storage_profile.data_disks + [vm.storage_profile.os_disk]:
                # Create a snapshot of the disk
                snapshot = {
                    'location': vm.location,
                    'creation_data': {
                        'create_option': 'Copy',
                        'source_uri': disk.managed_disk.id
                    }
                }
                async_snapshot_creation = self.compute_client.snapshots.begin_create_or_update(resource_group_name, snapshot_name, snapshot)
                async_snapshot_creation.wait(timeout=WAIT_DELAY)

            logger.info(f"Successfully created snapshot {snapshot_name} for VM {path_to_vm}.")
        except Exception as e:
            logger.error(f"Failed to create snapshot {snapshot_name} of the Azure VM {path_to_vm}: {str(e)}")
            raise

    def revert_to_snapshot(self, path_to_vm: str, snapshot_name: str):
        logger.info(f"Reverting VM to snapshot: {snapshot_name}...")
        resource_group_name, vm_name = path_to_vm.split('/')

        vm = self.compute_client.virtual_machines.get(resource_group_name, vm_name)

        # Stop the VM for disk creation
        logger.info(f"Stopping VM: {vm_name}")
        async_vm_stop = self.compute_client.virtual_machines.begin_deallocate(resource_group_name, vm_name)
        async_vm_stop.wait(timeout=WAIT_DELAY)  # Wait for the VM to stop

        try:
            # Get the snapshot
            snapshot = self.compute_client.snapshots.get(resource_group_name, snapshot_name)

            # Get the original disk information
            original_disk_id = vm.storage_profile.os_disk.managed_disk.id
            disk_name = original_disk_id.split('/')[-1]
            if disk_name[-1] in ['0', '1']:
                new_disk_name = disk_name[:-1] + str(int(disk_name[-1])^1)
            else:
                new_disk_name = disk_name + "0"

            # Delete the disk if it exists
            self.compute_client.disks.begin_delete(resource_group_name, new_disk_name).wait(timeout=WAIT_DELAY)

            # Make sure the disk is deleted before proceeding to the next step
            disk_deleted = False
            polling_interval = 10
            attempts = 0
            while not disk_deleted and attempts < MAX_ATTEMPTS:
                try:
                    self.compute_client.disks.get(resource_group_name, new_disk_name)
                    # If the above line does not raise an exception, the disk still exists
                    time.sleep(polling_interval)
                    attempts += 1
                except ResourceNotFoundError:
                    disk_deleted = True

            if not disk_deleted:
                logger.error(f"Disk {new_disk_name} deletion timed out.")
                raise

            # Create a new managed disk from the snapshot
            snapshot = self.compute_client.snapshots.get(resource_group_name, snapshot_name)
            disk_creation = {
                'location': snapshot.location,
                'creation_data': {
                    'create_option': 'Copy',
                    'source_resource_id': snapshot.id
                },
                'zones': vm.zones if vm.zones else None  # Preserve the original disk's zone
            }
            async_disk_creation = self.compute_client.disks.begin_create_or_update(resource_group_name, new_disk_name, disk_creation)
            restored_disk = async_disk_creation.result()  # Wait for the disk creation to complete

            vm.storage_profile.os_disk = {
                'create_option': vm.storage_profile.os_disk.create_option,
                'managed_disk': {
                    'id': restored_disk.id
                }
            }

            async_vm_creation = self.compute_client.virtual_machines.begin_create_or_update(resource_group_name, vm_name, vm)
            async_vm_creation.wait(timeout=WAIT_DELAY)

            # Delete the original disk
            self.compute_client.disks.begin_delete(resource_group_name, disk_name).wait()

            logger.info(f"Successfully reverted to snapshot {snapshot_name}.")
        except Exception as e:
            logger.error(f"Failed to revert the Azure VM {path_to_vm} to snapshot {snapshot_name}: {str(e)}")
            raise

    def stop_emulator(self, path_to_vm, region=None):
        logger.info(f"Stopping Azure VM {path_to_vm}...")
        resource_group_name, vm_name = path_to_vm.split('/')

        vm = self.compute_client.virtual_machines.get(resource_group_name, vm_name, expand='instanceView')
        power_state = vm.instance_view.statuses[-1].code
        if power_state == "PowerState/deallocated":
            print("VM is already stopped.")
            return

        try:
            for _ in range(MAX_ATTEMPTS):
                async_vm_deallocate = self.compute_client.virtual_machines.begin_deallocate(resource_group_name, vm_name)
                logger.info(f"Stopping VM {path_to_vm}...")
                # Wait for the instance to start
                async_vm_deallocate.wait(timeout=WAIT_DELAY)
                vm = self.compute_client.virtual_machines.get(resource_group_name, vm_name, expand='instanceView')
                power_state = vm.instance_view.statuses[-1].code
                if power_state == "PowerState/deallocated":
                    logger.info(f"VM {path_to_vm} is already stopped.")
                    break
        except Exception as e:
            logger.error(f"Failed to stop the Azure VM {path_to_vm}: {str(e)}")
            raise
