## 💾 Installation of VMware Workstation Pro 

---

1. Download VMware Workstation Pro from the [official website](https://www.vmware.com/products/workstation-pro/workstation-pro-evaluation.html). The version we are using is 17.5.1. For systems with Apple chips, you should install [VMware Fusion](https://www.vmware.com/go/getfusion).

2. Install VMware Workstation
    - **[On Linux](https://docs.vmware.com/en/VMware-Workstation-Pro/17/com.vmware.ws.using.doc/GUID-1F5B1F14-A586-4A56-83FA-2E7D8333D5CA.html):** Run the following command in your terminal, where `xxxx-xxxxxxx` represents the version number and internal version number.
    ```
    sudo sh VMware-Workstation-xxxx-xxxxxxx.architecture.bundle --console
    ```   

   - **[On Windows](https://docs.vmware.com/en/VMware-Workstation-Pro/17/com.vmware.ws.using.doc/GUID-F5A7B3CB-9141-458B-A256-E0C3EA805AAA.html):**  Ensure that you're logged in as either the Administrator user or as a user who belongs to the local Administrators group. If you're logging in to a domain, make sure your domain account has local administrator privileges. Proceed by double-clicking the `VMware-workstation-xxxx-xxxxxxx.exe` file. Be aware that you might need to reboot your host system to finalize the installation.

    - **[For systems with Apple chips](https://docs.vmware.com/en/VMware-Fusion/13/com.vmware.fusion.using.doc/GUID-ACC3A019-93D3-442C-A34E-F7755DF6733B.html):** Double-click the `VMware-Fusion-xxxx-xxxxxxx.dmg`  file to open it. In the Finder window that appears, double-click the 'Install Fusion' icon. When prompted, enter your administrator username and password. 

    > **Note:** You need to fill the activation key during the installation process when prompted.

3. Verify the successful installation by running the following:
    ```
    vmrun -T ws list
    ```
    If the installation along with the environment variable set is successful, you will see the message showing the current running virtual machines.
