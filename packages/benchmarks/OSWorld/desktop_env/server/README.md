# Server setup

This README is useful if you want to set up your own machine for the environment. This README is not yet finished. Please contact the author if you need any assistance.

## Configuration Overview

The following sections contain guidelines for configuring the system image to ensure benchmark examples can run properly.

The main configuration requirements include:

1. **Account Credentials**: 
Our benchmark configurations are based on specific username and password settings (with username `user` and password `password`). 
Please ensure these settings remain consistent or update the corresponding configuration files.

2. **Service Setup**: 
Our environment operates through a service that automatically starts at boot time, as shown in the figure below. The service needs to be properly configured and placed.
![](https://os-world.github.io/static/images/env.png)

3. **Accessibility Tree Support**:  
Benchmark examples rely on accessibility tree functionality. The necessary support packages need to be installed.

4. **System Service Management**:  
Certain system services that may cause interference need to be disabled, such as automatic updates and notification pop-ups.

5. **Required Software Installation**:  
Ensure all necessary software packages required by the benchmark examples are properly installed.

6. **Software Configuration**: 
Various software packages require specific configurations, such as disabling certain auto-save features or installing additional plugins.

7. **Port Configuration**: 
To monitor and control software states from the host machine, specific port configurations are needed for various applications.

8. **Miscellaneous Settings**: 
Additional system-specific settings need to be configured, such as desktop environment settings and display resolution.

Detailed instructions for each of these requirements will be provided in the following sections.


## [Ubuntu](https://huggingface.co/datasets/xlangai/ubuntu_osworld)

Make a new VM with the Ubuntu 20.04 LTS image.

### How to install Ubuntu Desktop (package: ubuntu-desktop) with GNOME desktop environment on Ubuntu 22.04 system.

```bash
sudo apt update
sudo apt install ubuntu-desktop
sudo systemctl set-default graphical.target
```

### Account Credentials

Download the iso file from the [Ubuntu website](https://ubuntu.com/download/alternative-downloads) and install it in the VM. 

Using GUI:
The default username should be `user` and the password should be `password` when you are asked to set up the account. Give the user sudo permission.

Using Command Line:
```bash
sudo adduser user
usermod -aG sudo user
```

### Installation and Auto-login Setup

1. Download the iso file from the [Ubuntu website](https://ubuntu.com/download/alternative-downloads) and install it in the VM. 
The default username should be `user` and the password should be `password` when you are asked to set up the account.

2. To enable automatic login:

Using GUI:
```bash
# Open Settings -> Users
# Click Unlock button and enter password
# Toggle "Automatic Login" to ON for user 'user'
```

Or using Command Line:
```bash
# Edit the custom configuration file
sudo nano /etc/gdm3/custom.conf

# Under [daemon] section, add or modify these lines:
AutomaticLoginEnable=true
AutomaticLogin=user

# Save the file and restart the system
sudo systemctl restart gdm3
```

After setting up automatic login, the system will boot directly into the desktop environment without requiring password input, which enables seamless startup experience for automated testing environments.

### VNC Configuration

1. Install x11vnc
```
sudo apt update
sudo apt install x11vnc
```

2. Install noVNC
```
sudo snap install novnc
```

3. Create system services for x11vnc and novnc:
- Go to directory cd `/etc/systemd/user/`
- Write a file `novnc.service` with the following content:
```
[Unit]
Description=noVNC Service
After=x11vnc.service network.target snap.novnc.daemon.service
Wants=x11vnc.service

[Service]
Type=simple
ExecStart=/snap/bin/novnc --vnc localhost:5900 --listen 5910
Restart=on-failure
RestartSec=3
Environment=DISPLAY=:0
Environment=XAUTHORITY=/home/user/.Xauthority
Environment=SNAP_COOKIE=/run/snap.cookie
Environment=SNAP_NAME=novnc
Environment=SNAP_REVISION=current

[Install]
WantedBy=default.target
```
Write a file `x11vnc.service` with the following content:
```
[Unit]
Description=X11 VNC Server
After=display-manager.service network.target
Wants=display-manager.service

[Service]
Type=simple
ExecStart=x11vnc -display :0 -rfbport 5900 -forever
Restart=on-failure
RestartSec=3
Environment=DISPLAY=:0
Environment=XAUTHORITY=/home/user/.Xauthority

[Install]
WantedBy=default.target
```

4. Enable both services:
```
systemctl --user daemon-reload
systemctl --user enable novnc.service
systemctl --user enable x11vnc.service
systemctl --user start x11vnc.service
systemctl --user start novnc.service
```

5. Allow VNC port:
Expose 5910 port in the firewall and any other security tools you are using.

6. Access the VNC server:
Connect to the VNC via `http://[Instance IP]:5910/vnc.html`

### Display Configuration

> **⚠️ IMPORTANT NOTE**: The display configuration is critical for proper system operation. Incorrect settings can prevent the graphical environment from starting and potentially crash the X server. Make sure to follow these steps carefully and verify each configuration file. If you encounter any issues, check the X server logs at `/var/log/Xorg.0.log` for troubleshooting. Backup your existing X11 configuration before making any changes.


1. Install dummy video driver:
```
sudo apt-get install xserver-xorg-video-dummy
```

Go to `/etc/X11/` and create a file named `xorg.conf` with the following content:
```
Section "ServerLayout"
    Identifier "X.org Configured"
    Screen 0 "Screen0" 0 0
    InputDevice "Mouse0" "CorePointer"
    InputDevice "Keyboard0" "CoreKeyboard"
EndSection

Section "Files"
    ModulePath "/usr/lib/xorg/modules"
    FontPath "/usr/share/fonts/X11/misc"
    FontPath "/usr/share/fonts/X11/cyrillic"
    FontPath "/usr/share/fonts/X11/100dpi/:unscaled"
    FontPath "/usr/share/fonts/X11/75dpi/:unscaled"
    FontPath "/usr/share/fonts/X11/Type1"
    FontPath "/usr/share/fonts/X11/100dpi"
    FontPath "/usr/share/fonts/X11/75dpi"
    FontPath "built-ins"
EndSection

Section "Module"
    Load "glx"
EndSection

Section "InputDevice"
    Identifier "Keyboard0"
    Driver "kbd"
EndSection

Section "InputDevice"
    Identifier "Mouse0"
    Driver "mouse"
    Option "Protocol" "auto"
    Option "Device" "/dev/input/mice"
    Option "ZAxisMapping" "4 5 6 7"
EndSection

Section "Monitor"
    Identifier "Monitor0"
    VendorName "Monitor Vendor"
    ModelName "Monitor Model"
    HorizSync 28.0-80.0
    VertRefresh 48.0-75.0
EndSection

Section "Device"
    ### Available Driver options are:-
    ### Values: <i>: integer, <f>: float, <bool>: "True"/"False",
    ### <string>: "String", <freq>: "<f> Hz/kHz/MHz",
    ### <percent>: "<f>%"
    ### [arg]: arg optional
    #Option "SWcursor" # [<bool>]
    #Option "kmsdev" # <str>
    #Option "ShadowFB" # [<bool>]
    #Option "AccelMethod" # <str>
    #Option "PageFlip" # [<bool>]
    #Option "ZaphodHeads" # <str>
    #Option "DoubleShadow" # [<bool>]
    #Option "Atomic" # [<bool>]
    #Option "VariableRefresh" # [<bool>]
    #Option "UseGammaLUT" # [<bool>]
    #Option "AsyncFlipSecondaries" # [<bool>]
    Identifier "Card0"
    Driver "modesetting"
    BusID "PCI:0:30:0"
    VideoRam 256000
EndSection

Section "Screen"
    Identifier "Screen0"
    Device "Device0"
    Monitor "Monitor0"
    DefaultDepth 24
    SubSection "Display"
        Depth 24
        Modes "1920x1080"
    EndSubSection
EndSection
```

2. In the same directory as the previous step, go to its sub-directory `xorg.conf.d` , create a file named `10-dummy.conf` with the following content:
```
Section "Device"
    Identifier "DummyDevice"
    Driver "dummy"
    VideoRam 32768
EndSection

Section "Monitor"
    Identifier "DummyMonitor"
    HorizSync 28.0-80.0
    VertRefresh 48.0-75.0
    Modeline "1920x1080" 172.80 1920 2048 2248 2576 1080 1083 1088 1120
EndSection

Section "Screen"
    Identifier "DummyScreen"
    Device "DummyDevice"
    Monitor "DummyMonitor"
    DefaultDepth 24
    SubSection "Display"
        Depth 24
        Modes "1920x1080"
    EndSubSection
EndSection
```

3. Reload the display manager:
```
sudo systemctl restart display-manager
```

### Set up the OSWorld server service in VM
Upload the OSWorld server to the home directory (/home/user) of user (via scp or git clone).

1. Copy the `main.py` and `pyxcursor.py` and  to the `/home/user-name` where the `user-name` is your username of the ubuntu, here we make it `user` as default. If you customize the path of placing these files in this step, you should change the parameters in the service file we will mention later accordingly.

2. First please set up the environment:
```shell
sudo apt install python3
pip3 install -r requirements.txt
sudo apt-get install python3-tk python3-dev
sudo apt install gnome-screenshot
sudo apt install wmctrl
sudo apt install ffmpeg
sudo apt install socat
sudo apt install xclip
```

If you encounter an error about python not being found, run:
```
sudo ln -s /usr/bin/python3 /usr/bin/python
```

if you customize the environment in this step, you should change the parameters in the service file we will mention later accordingly.

3. Due to some configuration issues, you need to modify the `osworld_server.service` file:
1) In our released version, the X server is set to :1, but the default X server is actually :0. You need to modify the `osworld_server.service` file to change the `DISPLAY` variable from `:1` to `:0`.
Change the following line:
```
Environment="DISPLAY=:1"
```
to
```
Environment="DISPLAY=:0"
```
2) Need to add environment variables to enable DBUS to change wallpaper.
Change the following line:
```
Environment="DISPLAY=:0"
```
to
```
Environment="DISPLAY=:0;DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus"
```

4. Copy the `osworld_server.service` to the systemd configuration directory at `/etc/systemd/system/`:
```shell
sudo cp osworld_server.service /etc/systemd/system/
```

Reload the systemd daemon to recognize the new service:
```shell
sudo systemctl daemon-reload
```

Enable the service to start on boot:
```shell
sudo systemctl enable osworld_server.service
```

Start the service:
```shell
sudo systemctl start osworld_server.service
```

Verify the service is running correctly:
```shell
sudo systemctl status osworld_server.service
```

You should see output indicating the service is active and running. If there are errors, review the logs with `journalctl -xe` for further troubleshooting.

If you need to make adjustments to the service configuration, you can edit the `/etc/systemd/system/osworld_server.service` file:
```shell
sudo nano /etc/systemd/system/osworld_server.service
```

After making changes, reload the daemon and restart the service:
```shell
sudo systemctl daemon-reload
sudo systemctl enable osworld_server.service
sudo systemctl start osworld_server.service
```

### Accessibility Tree Support

To support the accessibility tree functionality, you'll need to install pyastpi2 in your Ubuntu environment. This package enables access to accessibility information and tree structures.

Installation steps:

```bash
# Update package list and ensure pip is installed
sudo apt-get update
sudo apt-get install python3-pip

# Install pyastpi2 using pip
pip3 install pyastpi2
```

### Xorg Configuration

Regarding the graphics display system, we need to ensure that Ubuntu displays images using the **Xorg** protocol instead of **Wayland**. Since **Wayland** is typically the default setting for Ubuntu, we will need to manually change the settings.

1. Click the user menu in the upper right corner and select "Log Out" or "Sign Off."
2. On the login screen, click on the username.
3. Before entering the password, click the gear icon in the lower right or upper right corner of the screen (it may need to be displayed after clicking the username first).
4. Select "Ubuntu on Xorg" from the pop-up menu.

You can run the following command to check if **Xorg** is being used:

```bash
echo $XDG_SESSION_TYPE
```

### System Service Management (Optional)

The automatic software update service can interfere with benchmark examples. To disable this service, you can refer to the https://www.makeuseof.com/disable-automatic-updates-in-ubuntu/ for the solution. 

You can check and manage system services using systemctl commands. For example, to verify if a service like unattended-upgrades is installed and running on your system:

```bash
# Check service status
sudo systemctl status unattended-upgrades.service
```

If the output is `x11`, it means you have switched to **Xorg**.

To disable a system service:
```bash
# Disable and stop the service
sudo systemctl disable unattended-upgrades
sudo systemctl stop unattended-upgrades
```

To verify service configurations, you can use apt-config:
```bash
# Check current configurations
apt-config dump APT::Periodic::Update-Package-Lists
apt-config dump APT::Periodic::Unattended-Upgrade
```


### Software Installation

#### Software Installation Source
Since for some examples like change the settings of certain software, we hardcode some paths in our evaluation file, which means you need to install the software to the specific path. Here we provide a list of software that you need to install and the certain source which default the path you should install them to.

1. Chrome: If you are using ARM System, download the chromium using `sudo snap install chromium` and make sure your Chromium config files are under `~/snap/chromium`; otherwise, download the chrome from the [Chromium](https://www.chromium.org/Home) and make sure your Chromium config files are under `~/.config/google-chrome`.
2. LibreOffice: Go to [LibreOffice Website](https://www.libreoffice.org/), select "Download Libreoffice", select "older versions" in the bottom of the page, and download `7.3.7.2` version.
3. GIMP: Search "GIMP" in "Ubuntu Software" and install it. Our GIMP version is `2.10.30`.
4. VLC: Search "VLC" in "Ubuntu Software" and install it. Our VLC version is `3.0.16`.
5. VSCode: Go to [VSCode Website](https://code.visualstudio.com/download), download the `.deb` file, and install it. Our VSCode version is `1.91.1`.

#### Additional Inner Software Installation
> **⚠️ IMPORTANT NOTE**: The software installation and configuration steps described in this section are crucial for maintaining consistent task execution and performance. Skipping or incorrectly configuring these components may lead to task failures or degraded performance. Please follow the installation instructions carefully and verify each component is properly set up before proceeding.


##### LibreOffice font installation 
Some examples in LibreOffice Impress use non-default system fonts, and you need to download the corresponding **TTF files** and put them in the system fonts directory. 
[Here](https://huggingface.co/datasets/xlangai/ubuntu_osworld_file_cache/resolve/main/fonts_20250608_fixed.zip) we provides all the fonts downloaded, just download it, and unzip to the system fonts directory (which usually `usr/share/fonts/`).
```bash
unzip fonts.zip -d /usr/share/fonts/
```

And then run the following command to refresh the font cache:
```bash
sudo fc-cache -fv
```

##### Customized Plugin Installation

**VS Code plugin installation:**
To extract relevant internal information and configurations from the VS Code environment, we principally leverage the capabilities offered by the VS Code Extension API. Here's how to install the extension developed by ourselves:
```bash
1. Download the extension from: https://github.com/xlang-ai/OSWorld/blob/04a9df627c7033fab991806200877a655e895bfd/vscodeEvalExtension/eval-0.0.1.vsix
2. Open VS Code
3. Go to Extensions -> ... -> Install from VSIX... -> choose the downloaded eval-0.0.1.vsix file
```


### Software Configuration
1. LibreOffice Default Format Settings:
```bash
# Open LibreOffice Writer/Calc/Impress
# Go to Tools -> Options -> Load/Save -> General
# Under "Default file format and ODF settings":
# Change "Document type" to "Text document"
# Set "Always save as" to "Word 2007-365 (.docx)"
# Change "Document type" to "Spreadsheet"
# Set "Always save as" to "Excel 2007-365 (.xlsx)"
# Change "Document type" to "Presentation"
# Set "Always save as" to "PowerPoint 2007-365 (.pptx)"
```

2. Chrome password requirement removal:
Chrome requests a password input when first opened after system startup, which can interfere with our experiments. Here's how to disable this feature:

```bash
# Prevent Chrome from using keyring
mkdir -p ~/.local/share/keyrings
touch ~/.local/share/keyrings/login.keyring
```

Or you can use any ways to disable the keyring service, which will prevent Chrome from requesting a password input.

3. VSCode Trust Settings:
To prevent VSCode from showing "Do you trust this workspace?" dialog when opening projects, configure the following setting:

```bash
# Open VSCode
# Go to File -> Preferences -> Settings (or press Ctrl+,)
# In the search bar, type "workspace trust"
# Find "Security: Workspace Trust Enabled" and uncheck it
# Find "Security: Workspace Trust Banner" and set to "never"
# Find "Security: Workspace Trust Empty Window" and uncheck it
# Find "Security: Workspace Trust Startup Prompt" and set to "never"
```

This disables the workspace trust feature and prevents trust dialog prompts when opening projects.

### Network Configuration

#### Firewall Configuration

In OSWorld, we need the following ports to be open:
```
server_port = 5000
chromium_port = 9222
vnc_port = 8006
vlc_port = 8080
novnc_port = 5910
```

Please open the corresponding ports in the firewall and any other security tools you are using.

#### socat Installation

Ensure `socat` is installed to enable port forwarding.

```sh
sudo apt install socat
```

#### Network Configuration for Remote Control

##### VLC Configuration
To enable remote control of VLC media player, follow these configuration steps:

1. Enable HTTP interface:
```bash
# Open VLC
# Go to Tools -> Preferences
# Show Settings: All (bottom left)
# Navigate to Interface -> Main interfaces
# Check 'Web' option
```

2. Configure HTTP interface settings:
```bash
# Still in Preferences
# Navigate to Interface -> Main interfaces -> Lua
# Under Lua HTTP:
# - Set Password to 'password'
```

The following is the screenshot of the VLC configuration:
![vlc_configuration](https://os-world.github.io/static/images/vlc_configuration.png)
When VLC is open, the service will be running on port 8080.

##### Chrome Configuration
When you open Chrome through the GUI interface, it doesn't automatically enable remote debugging port 1337 (the port we set for controlling the client machine's Chrome through the host, which gets forwarded to 9222). 
This is because GUI startup and command-line startup use different parameters.
The consequence is that once Chrome is closed and reopened, it will fail to connect.
To ensure Chrome uses consistent debugging ports even after being closed and reopened, follow these steps:

1. Create or edit Chrome desktop entry:
```bash
sudo vim ~/.local/share/applications/google-chrome.desktop
```
If that doesn't work, try:
```
sudo vim /usr/share/applications/google-chrome.desktop
```

2. Modify **all** the `Exec` lines to include debugging port, for example, change:
```
Exec=/usr/bin/google-chrome-stable %U
```
into:
```
Exec=/usr/bin/google-chrome-stable --remote-debugging-port=1337 --remote-debugging-address=0.0.0.0 %U
```

In cases where Chrome is needed, the 1337 will be forwarded to 9222 in the virtual machine via socat.


### Miscellaneous Settings  

#### Screen Resolution

The required screen resolution for the virtual machine is 1920x1080 in OSWorld and we did make some hardcode related to this resolution in our configuration file in some examples, but only a few. 
So please set the screen resolution to 1920x1080 in the virtual machine settings.

#### Automatic Suspend

To close automatic suspend, open Setting app and enter "Power" section. Switch "Screen Blank" to "Never" and "Automatic Suspend" to "Off".

#### Additional Installation

Activating the window manager control requires the installation of `wmctrl`:
```bash
sudo apt install wmctrl
```
Otherwise, you cannot control the window manager in the virtual machine when running the experiments. Some cases will be effected.

To enable recording in the virtual machine, you need to install `ffmpeg`:
```bash
sudo apt install ffmpeg
```
Otherwise you cannot get the video recording of the virtual machine when running the experiments.


### Others Information

#### About the Converted Accessibility Tree

For several applications like Firefox or Thunderbird, you should first enable

```sh
gsettings set org.gnome.desktop.interface toolkit-accessibility true
```

to see their accessibility tree.

##### Example of AT

An example of a node:

```xml
<section xmlns:attr="uri:deskat:attributes.at-spi.gnome.org" attr:class="subject" st:enabled="true" cp:screencoord="(1525, 169)", cp:windowcoord="(342, 162)", cp:size="(327, 21)">
    歡迎使用新的 Outlook.com 帳戶
</section>
```

An example of a tree:

```xml
<desktop-frame ...>
    <application name="Thunderbird" ...>
        ... <!-- nodes of windows -->
    </application>
    ...
</desktop-frame>
```

##### Useful attributes

1. `name` - shows the name of application, title of window, or name of some
   component
2. `attr:class` - somewhat the same role as `class` in HTML
3. `attr:id` - somewhat the same role as `id` in HTML
4. `cp:screencoord` - absolute coordinator on the screen
5. `cp:windowcoord` - relative coordinator in the window
6. `cp:size` - the size

Also several states like `st:enabled` and `st:visible` can be indicated. A full
state list is available at
<https://gitlab.gnome.org/GNOME/pyatspi2/-/blob/master/pyatspi/state.py?ref_type=heads>.

##### How to use it in evaluation

See example `thunderbird/12086550-11c0-466b-b367-1d9e75b3910e.json` and
function `check_accessibility_tree` in `metrics/general.py`. You can use CSS
selector or XPath to reference a target nodes. You can also check its text
contents.

An example of a CSS selector:

```css
application[name=Thunderbird] page-tab-list[attr|id="tabmail-tabs"]>page-tab[name="About Profiles"]
```

This selector will select the page tab of profile manager in Thunderbird (if open).

For usage of CSS selector: <https://www.w3.org/TR/selectors-3/>. For usage of XPath: <https://www.w3.org/TR/xpath-31/>.

##### Manual check

You can use accerciser to check the accessibility tree on GNOME VM.

```sh
sudo apt install accerciser
```

## [MacOS](https://huggingface.co/datasets/xlangai/macos_osworld)
Coming soon...
