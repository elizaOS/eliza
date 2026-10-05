from abc import ABC, abstractmethod


class Provider(ABC):
    def __init__(self, region: str = None):
        """
        Region of the cloud service.
        """
        self.region = region

    @abstractmethod
    def start_emulator(self, path_to_vm: str, headless: bool):
        """
        Method to start the emulator.
        """
        pass

    @abstractmethod
    def get_ip_address(self, path_to_vm: str) -> str:
        """
        Method to get the private IP address of the VM. Private IP means inside the VPC.
        """
        pass

    @abstractmethod
    def save_state(self, path_to_vm: str, snapshot_name: str):
        """
        Method to save the state of the VM.
        """
        pass

    @abstractmethod
    def revert_to_snapshot(self, path_to_vm: str, snapshot_name: str) -> str:
        """
        Method to revert the VM to a given snapshot.
        """
        pass

    @abstractmethod
    def stop_emulator(self, path_to_vm: str):
        """
        Method to stop the emulator.
        """
        pass


class VMManager(ABC):
    checked_and_cleaned = False

    @abstractmethod
    def initialize_registry(self, **kwargs):
        """
        Initialize registry.
        """
        pass

    @abstractmethod
    def add_vm(self, vm_path, **kwargs):
        """
        Add the path of new VM to the registration.
        """
        pass

    @abstractmethod
    def delete_vm(self, vm_path, **kwargs):
        """
        Delete the registration of VM by path.
        """
        pass

    @abstractmethod
    def occupy_vm(self, vm_path, pid, **kwargs):
        """
        Mark the path of VM occupied by the pid.
        """
        pass

    @abstractmethod
    def list_free_vms(self, **kwargs):
        """
        List the paths of VM that are free to use allocated.
        """
        pass

    @abstractmethod
    def check_and_clean(self, **kwargs):
        """
        Check the registration list, and remove the paths of VM that are not in use.
        """
        pass

    @abstractmethod
    def get_vm_path(self, **kwargs):
        """
        Get a virtual machine that is not occupied, generate a new one if no free VM.
        """
        pass
