import os
from desktop_env.desktop_env import DesktopEnv

# To ensure the relative path works correctly, this script should be executed from the root of the project directory.
# For example: python osworld_setup/test_vmware.py
# The path is relative to the project root.

print(f"="*80)
print(f"If the download process begin, it's because you don't put the zip file in the vmware_vm_data/, or the hash of your zip file doesn't match the remote one hold by OSWorld official.")
print(f"="*80)
print(f"If the vmware_vm_data/Ubuntu*/ or vmware_vm_data/Ubuntu*/ has been deleted, don't panic. It will rebuild from correct zip file.")
print(f"="*80)

# Put zip in the vmware_vm_data/, and use this code. When the VMware is running this system, then stop python and the virtual machine
env = DesktopEnv(provider_name="vmware", os_type="Ubuntu", action_space="pyautogui")

env.reset()

obs = env._get_obs()  # Get the initial observation

obs, reward, done, info = env.step("pyautogui.rightClick()")

print(f"="*80)
print(f"VMware initialization completed!")
print(f"="*80)