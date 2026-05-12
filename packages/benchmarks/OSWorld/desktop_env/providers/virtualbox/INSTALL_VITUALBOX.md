## 💾 Installation of VirtualBox


1. Download the VirtualBox from the [official website](https://www.virtualbox.org/wiki/Downloads). Unfortunately, for Apple chips (M1 chips, M2 chips, etc.), VirtualBox is not supported. You can only use VMware Fusion instead.
2. Install VirtualBox. Just follow the instructions provided by the installer.
For Windows, you also need to append the installation path to the environment variable `PATH` for enabling the `VBoxManage` command. The default installation path is `C:\Program Files\Oracle\VirtualBox`.
3. Verify the successful installation by running the following:
    ```bash
    VBoxManage --version
    ```
    If the installation along with the environment variable set is successful, you will see the version of VirtualBox installed on your system.
