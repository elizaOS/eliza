## Introduction and Objectives of the WiFiPhisher Project

WiFiPhisher is a **rogue access point framework for WiFi security testing**. It can create fake WiFi networks to gain a man-in-the-middle position and further conduct phishing attacks on connected clients. This tool performs excellently in penetration testing and WiFi security assessment, capable of implementing "the most effective WiFi association attacks and phishing techniques". Its core functions include: WiFi client association (using techniques such as Evil Twin, KARMA, and Known Beacons), **man-in-the-middle attacks and phishing page services** (supporting various phishing scenarios such as firmware upgrades, OAuth logins, and plugin updates), as well as credential capture and malware delivery for victim devices. In short, WiFiPhisher aims to provide a powerful WiFi security testing platform for evaluating the security of wireless networks and discovering potential security vulnerabilities (for example, attracting clients to connect by creating fake APs and obtaining WiFi passwords or user credentials through phishing pages).

## Natural Language Instruction (Prompt)

Please create a Python project named WiFiPhisher to implement a WiFi security testing framework. This project should include the following functions:

1. **WiFi Network Interface Management**: It should be able to detect and manage wireless network interfaces, support AP mode and Monitor mode, automatically identify available wireless network cards, and configure their operating modes. It is necessary to implement functions such as MAC address randomization of interfaces, creation of virtual interfaces, and integration with network managers.

2. **Rogue Access Point Creation**: Implement the creation and management of fake WiFi access points, support WPA/WPA2 encryption configuration, integrate DHCP and DNS servers, and be able to assign IP addresses to connected clients and provide network services.

3. **Implementation of WiFi Attack Techniques**: Implement various WiFi attack techniques, including Evil Twin attacks (creating fake APs identical to the target network), KARMA attacks (responding to clients' probe requests), Known Beacons attacks (broadcasting known network names), etc.

4. **Phishing Page System**: Provide templates for various phishing scenarios, including firmware upgrade pages, OAuth login pages, plugin update pages, WiFi connection pages, etc., and support dynamic content generation and user interaction handling.

5. **Extended System Architecture**: Design a modular extended system that supports extension modules such as deauth (deauthentication attack), lure10 (location spoofing attack), wpspbc (WPS button attack), and knownbeacons (known beacons attack).

6. **Network Traffic Management**: Implement functions such as firewall rule management, NAT configuration, and traffic redirection to ensure normal access to phishing pages and network isolation.

7. **User Interface System**: Provide a text user interface based on curses, supporting functions such as access point selection, phishing scenario selection, and real-time status display.

8. **Victim Management**: Implement the identification, tracking, and management of victim devices, including MAC address matching, operating system identification, and device manufacturer identification.

9. **Credential Capture System**: Implement the capture and processing of user input, supporting the acquisition of credentials for various authentication methods, including WiFi passwords and social media accounts.

10. **Operation Mode Management**: Support the configuration of various operation modes, including single-interface mode, dual-interface mode, triple-interface mode, etc., and automatically select the optimal mode based on the hardware configuration.

11. **Network Reconnaissance Function**: Implement functions such as wireless network scanning, access point discovery, and client detection to support the selection of attack targets.

12. **Security Verification System**: Integrate functions such as WPA handshake verification and password strength checking to ensure the effectiveness and security of attacks.

13. **Core File Requirements**: The project must include a complete setup.py file, which should configure the project as an installable package (supporting pip install and editable mode installation) and declare a complete list of dependencies - including core libraries such as scapy (network packet processing), tornado (Web service construction), pyric (wireless network card management), roguehostapd (forged access point), and pbkdf2 (password hashing calculation) - to ensure the normal dependencies of functions such as packet capture, access point simulation, and deployment of Web phishing pages in the attack process. The setup.py file should verify the effectiveness of all functional modules (such as access point forgery, client deception, loading of phishing templates, and running of extension plugins) through configuration, support triggering full-function verification through test commands, covering key aspects such as wireless interface configuration, linkage of attack processes, and handling of abnormal scenarios. At the same time, it is necessary to provide wifiphisher/__init__.py as a unified API entry. This file should integrate key components from the core modules: import AccessPoint (forged access point management class), victim (processing of victim device information), interfaces (network interface management tools), and constants (definition of attack constants) from the common module; import ExtensionManager (extension plugin management class) and specific extension functions (such as deauth (client disconnection attack), lure10 (bait attack plugin)) from the extensions module; import PhishingTemplate (phishing page template processing class) from the template module; in addition, export core components such as Extension (extension base class) and provide version information through __version__, ensuring that users can access all major functions through a simple statement like from wifiphisher import AccessPoint, ExtensionManager, covering core capabilities such as access point configuration, invocation of extension plugins, and control of phishing processes. In pywifiphisher.py, the WifiphisherEngine class should serve as the core manager of the attack process, coordinating the work of various modules: creating a forged hotspot through AccessPoint, configuring the wireless network card to monitoring mode using interfaces; invoking extensions.deauth to send deauthentication frames to disconnect the target device, and inducing the device to access the forged network in combination with the lure10 extension; loading and running various attack plugins using ExtensionManager, and tracking the status of victims through the victim module; linking with PhishingTemplate to deploy phishing pages (relying on tornado to build a temporary Web service), and finally completing the full-process attack coordination from device deception to information theft, ensuring that all modules are linked in an orderly manner according to the attack logic and improving the attack success rate.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.11.13

### Core Dependency Library Versions

```Plain
iniconfig    2.1.0
mock         5.2.0
packaging    25.0
pbkdf2       1.3
pip          24.0
pluggy       1.6.0
Pygments     2.19.2
PyRIC        0.1.6.4
pytest       8.4.1
roguehostapd 1.1.2
scapy        2.6.1
setuptools   65.5.1
tornado      6.5.2
wheel        0.45.1
wifiphisher  1.4
```

## WiFiPhisher Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .editorconfig
├── .gitignore
├── .style.yapf
├── .travis.yml
├── CHANGELOG
├── CODE_OF_CONDUCT.md
├── FUNDING.yml
├── ISSUE_TEMPLATE.md
├── LICENSE.txt
├── MANIFEST.in
├── README.md
├── bin
│   ├── wifiphisher
├── docs
│   ├── Makefile
│   ├── _static
│   │   ├── wifiphisher.png
│   ├── conf.py
│   ├── custom_phishing_scenario.rst
│   ├── extensions.rst
│   ├── faq.rst
│   ├── index.rst
│   ├── opmodes.rst
├── pylintrc
├── setup.py
└── wifiphisher
    ├── __init__.py
    ├── common
    │   ├── __init__.py
    │   ├── accesspoint.py
    │   ├── constants.py
    │   ├── extensions.py
    │   ├── firewall.py
    │   ├── globals.py
    │   ├── interfaces.py
    │   ├── macmatcher.py
    │   ├── opmode.py
    │   ├── phishinghttp.py
    │   ├── phishingpage.py
    │   ├── recon.py
    │   ├── tui.py
    │   ├── uimethods.py
    │   ├── utilities.py
    │   ├── victim.py
    ├── data
    │   ├── cert
    │   │   ├── server.pem
    │   ├── locs
    │   │   ├── .gitkeep
    │   ├── phishing-pages
    │   │   ├── firmware-upgrade
    │   │   │   ├── config.ini
    │   │   │   ├── html
    │   │   │   │   ├── bootstrap.min.css
    │   │   │   │   ├── bootstrap.min.js
    │   │   │   │   ├── index.html
    │   │   │   │   ├── jquery.min.js
    │   │   │   │   ├── loading.html
    │   │   │   │   ├── static
    │   │   │   │   │   ├── bootstrap.min.css
    │   │   │   │   │   ├── bootstrap.min.js
    │   │   │   │   │   ├── font-awesome-4.7.0
    │   │   │   │   │   │   ├── css
    │   │   │   │   │   │   │   ├── font-awesome.css
    │   │   │   │   │   │   │   ├── font-awesome.min.css
    │   │   │   │   │   │   ├── fonts
    │   │   │   │   │   │   │   ├── FontAwesome.otf
    │   │   │   │   │   │   │   ├── fontawesome-webfont.eot
    │   │   │   │   │   │   │   ├── fontawesome-webfont.svg
    │   │   │   │   │   │   │   ├── fontawesome-webfont.ttf
    │   │   │   │   │   │   │   ├── fontawesome-webfont.woff
    │   │   │   │   │   │   │   └── fontawesome-webfont.woff2
    │   │   │   │   │   ├── jquery.min.js
    │   │   │   │   └── upgrading.html
    │   │   ├── oauth-login
    │   │   │   ├── config.ini
    │   │   │   ├── html
    │   │   │   │   ├── fail.html
    │   │   │   │   ├── index.html
    │   │   │   │   ├── login.html
    │   │   │   │   ├── oauth.html
    │   │   │   │   ├── static
    │   │   │   │   │   ├── css
    │   │   │   │   │   │   ├── font-awesome.css
    │   │   │   │   │   │   ├── font-awesome.min.css
    │   │   │   │   │   │   ├── normalize.min.css
    │   │   │   │   │   │   ├── reset.css
    │   │   │   │   │   │   ├── roboto.css
    │   │   │   │   │   │   ├── style.css
    │   │   │   │   │   ├── js
    │   │   │   │   │   │   ├── index.js
    │   │   │   │   │   │   ├── jquery.min.js
    │   │   │   │   │   │   ├── jsframe.js
    │   │   │   │   │   │   ├── popup.js
    │   │   │   │   │   ├── ssl.png
    │   │   │   │   └── template.html
    │   │   ├── plugin_update
    │   │   │   ├── config.ini
    │   │   │   ├── html
    │   │   │   │   ├── css
    │   │   │   │   │   ├── bootstrap.min.css
    │   │   │   │   │   ├── theme.css
    │   │   │   │   ├── images
    │   │   │   │   │   ├── favicon.ico
    │   │   │   │   │   ├── plugins.png
    │   │   │   │   ├── index.html
    │   │   │   │   ├── js
    │   │   │   │   │   ├── bootstrap.min.js
    │   │   │   │   │   ├── jquery.js
    │   │   │   │   ├── static
    │   │   │   │   │   ├── css
    │   │   │   │   │   │   ├── bootstrap.min.css
    │   │   │   │   │   │   ├── theme.css
    │   │   │   │   │   ├── images
    │   │   │   │   │   │   ├── favicon.ico
    │   │   │   │   │   │   ├── plugins.png
    │   │   │   │   │   ├── js
    │   │   │   │   │   │   ├── bootstrap.min.js
    │   │   │   │   │   │   ├── jquery.js
    │   │   │   │   │   ├── update
    │   │   │   │   │   │   └── update.exe
    │   │   │   │   └── update
    │   │   │   │       └── update.exe
    │   │   ├── wifi_connect
    │   │   │   ├── config.ini
    │   │   │   └── html
    │   │   │       ├── behavior.js
    │   │   │       ├── chrome-offline.css
    │   │   │       ├── dinosaur.png
    │   │   │       ├── index.html
    │   │   │       ├── loading.html
    │   │   │       ├── mac-network-manager.css
    │   │   │       ├── opensans.css
    │   │   │       ├── opensans.ttf
    │   │   │       ├── question.png
    │   │   │       ├── static
    │   │   │       │   ├── behavior.js
    │   │   │       │   ├── chrome-offline.css
    │   │   │       │   ├── dinosaur.png
    │   │   │       │   ├── ios.css
    │   │   │       │   ├── mac-network-manager.css
    │   │   │       │   ├── opensans.css
    │   │   │       │   ├── opensans.ttf
    │   │   │       │   ├── question.png
    │   │   │       │   ├── style.css
    │   │   │       │   ├── wifi-icon.png
    │   │   │       │   ├── win-behavior.js
    │   │   │       ├── style.css
    │   │   │       ├── wifi-icon.png
    │   │   │       └── win-behavior.js
    │   ├── wifiphisher-known-open-wlans
    │   ├── wifiphisher-mac-prefixes
    │   ├── wifiphisher-os-initial-requests
    ├── extensions
    │   ├── __init__.py
    │   ├── deauth.py
    │   ├── handshakeverify.py
    │   ├── knownbeacons.py
    │   ├── lure10.py
    │   ├── roguehostapdinfo.py
    │   ├── wpspbc.py
    └── pywifiphisher.py

```

## API Usage Guide

### Core API

#### 1. Module Import

```python
# Import core modules
import wifiphisher.common.victim as victim
import wifiphisher.common.constants as constants
import wifiphisher.common.interfaces as interfaces
import wifiphisher.common.extensions as extensions

# Import extension modules
import wifiphisher.extensions.deauth as deauth
import wifiphisher.extensions.lure10 as lure10
import wifiphisher.extensions.knownbeacons as knownbeacons
import wifiphisher.extensions.wpspbc as wpspbc
import wifiphisher.extensions.handshakeverify as handshakeverify

# Other core modules
import wifiphisher.common.accesspoint as accesspoint
import wifiphisher.common.phishingpage as phishingpage
import wifiphisher.common.recon as recon
import wifiphisher.common.firewall as firewall
```

#### 2. WifiphisherEngine Class - Main Engine

**Function**: The main engine that manages the entire WiFi attack process, coordinating the work of various modules.

**Class Signature**:
```python
class WifiphisherEngine:
    def __init__(self):
        """Initialize the WiFiPhisher engine"""
    
    def start(self):
        """Start the attack process"""
    
    def stop(self):
        """Stop the attack process and clean up resources"""
```

**Main Methods**:
- `start()`: Start the complete attack process, including network reconnaissance, AP creation, and execution of extensions.
- `stop()`: Gracefully stop the attack and clean up all resources.
- `__init__()`: Initialize the engine and set default configurations.

#### 3. AccessPoint Class - Rogue Access Point Management

**Function**: Create and manage fake WiFi access points, including DHCP and DNS services.

**Class Signature**:
```python
class AccessPoint:
    @staticmethod
    def get_instance():
        """Get the singleton instance of AccessPoint"""
    
    def start(self, disable_karma=False):
        """Start the rogue AP"""
    
    def start_dhcp_dns(self):
        """Start the DHCP and DNS servers"""
    
    def on_exit(self):
        """Clean up resources"""
```

**Main Methods**:
- `get_instance()`: Get the singleton instance.
- `start(disable_karma=False)`: Start the rogue AP, optionally disabling the KARMA attack.
- `start_dhcp_dns()`: Start the DHCP and DNS servers.
- `on_exit()`: Clean up resources when the program exits.

**Attributes**:
- `interface`: The name of the AP interface.
- `essid`: The network name.
- `channel`: The working channel.
- `presharedkey`: The WPA/WPA2 password.
- `hostapd_object`: The hostapd object.

#### 4. ExtensionManager Class - Extended System Management

**Function**: Manage various WiFi attack extension modules, providing a modular architecture.

**Class Signature**:
```python
class ExtensionManager:
    def __init__(self, network_manager):
        """Initialize the extension manager"""
    
    def set_extensions(self, extensions):
        """Set the list of extensions to be loaded"""
    
    def init_extensions(self, shared_data):
        """Initialize the extension modules"""
    
    def start_extensions(self):
        """Start all extensions"""
    
    def get_output(self):
        """Get the output information of the extensions"""
    
    def on_exit(self):
        """Clean up extension resources"""
```

**Main Methods**:
- `set_extensions(extensions)`: Set the list of extensions.
- `init_extensions(shared_data)`: Initialize the extensions, passing in shared data.
- `start_extensions()`: Start all extension modules.
- `get_output()`: Get the output information of the extensions.
- `get_channels()`: Get the channel information of the extensions.
- `get_ui_funcs()`: Get the list of all UI methods.
- `get_backend_funcs()`: Get the dictionary of all backend methods.
- `set_interface(interface)`: Set the interface used by the extensions.
- `on_exit()`: Clean up extension resources.

**Attributes**:
- `_extensions_str`: A list of extension name strings.
- `_extensions`: A list of extension objects.
- `_interface`: The interface used by the extensions.
- `_packets_to_send`: A dictionary of packets to be sent.
- `_channels_to_hop`: A list of channels to hop.
- `_current_channel`: The current channel.

#### 5. NetworkManager Class - Network Interface Management

**Function**: Manage wireless network interfaces, supporting the switching between AP mode and Monitor mode.

**Class Signature**:
```python
class NetworkManager:
    def __init__(self):
        """Initialize the network manager"""
    
    def get_interface(self, has_ap_mode=False, has_monitor_mode=False):
        """Get a network interface that meets the conditions"""
    
    def set_interface_mode(self, interface_name, mode):
        """Set the operating mode of the interface"""
    
    def set_interface_mac(self, interface_name, mac_address=None):
        """Set the MAC address of the interface"""
    
    def up_interface(self, interface_name):
        """Enable the network interface"""
    
    def down_interface(self, interface_name):
        """Disable the network interface"""
```

**Main Methods**:
- `get_interface(has_ap_mode=False, has_monitor_mode=False)`: Get an interface that supports the specified mode.
- `get_interface_automatically()`: Automatically get a suitable interface.
- `set_interface_mode(interface_name, mode)`: Set the interface mode (AP/Monitor/Managed).
- `set_interface_mac(interface_name, mac_address=None)`: Set the MAC address. None means randomization.
- `get_interface_mac(interface_name)`: Get the MAC address of the interface.
- `set_interface_channel(interface_name, channel)`: Set the interface channel.
- `up_interface(interface_name)`: Enable the interface.
- `down_interface(interface_name)`: Disable the interface.
- `unblock_interface(interface_name)`: Unblock the interface.
- `add_virtual_interface(card)`: Add a virtual interface.
- `remove_vifs_added()`: Remove the added virtual interfaces.
- `nm_unmanage(interface)`: Cancel the management of the NetworkManager.
- `is_interface_valid(interface_name, mode=None)`: Verify whether the interface is valid.
- `start(args)`: Start the network manager.
- `on_exit()`: Clean up resources.

**Utility Functions**:
- `interface_property_detector(network_adapter)`: Detect and set interface properties (monitor/AP mode support).
- `is_managed_by_network_manager(interface_name)`: Check if interface is managed by NetworkManager.
- `is_wireless_interface(interface_name)`: Check if interface is a wireless interface.

**Exception Classes**:
- `InvalidInterfaceError`: Raised when interface is invalid or unavailable.
- `InvalidMacAddressError`: Raised when MAC address cannot be set.
- `InvalidValueError`: Raised when invalid value is supplied.
- `InterfaceCantBeFoundError`: Raised when no suitable interface can be found.
- `InterfaceManagedByNetworkManagerError`: Raised when interface is managed by NetworkManager.

**Attributes**:
- `internet_access_enable`: Whether to enable Internet access.
- `_interfaces`: A list of interfaces.
- `_active_interfaces`: A list of active interfaces.

#### 6. PhishingTemplate Class - Phishing Page Template

**Function**: Manage phishing page templates, supporting dynamic content generation.

**Class Signature**:
```python
class PhishingTemplate:
    def __init__(self, name):
        """Initialize the phishing template"""
    
    def get_display_name(self):
        """Get the display name"""
    
    def get_description(self):
        """Get the description information"""
    
    def get_path(self):
        """Get the template path"""
    
    def get_context(self):
        """Get the template context"""
    
    def has_payload(self):
        """Check if there is a malicious payload"""
```

**Main Methods**:
- `get_display_name()`: Get the display name of the template.
- `get_description()`: Get the description of the template.
- `get_path()`: Get the file path of the template.
- `get_context()`: Get the context data of the template.
- `has_payload()`: Check if it contains a malicious payload.

#### 7. TemplateManager Class - Template Manager

**Function**: Manage all phishing page templates, providing template loading and verification.

**Class Signature**:
```python
class TemplateManager:
    def __init__(self, data_pages=None):
        """Initialize the template manager"""
    
    def get_templates(self):
        """Get all available templates"""
    
    def is_valid_template(self, name):
        """Verify if the template is valid"""
    
    def find_user_templates(self):
        """Find user-defined templates"""
```

**Main Methods**:
- `get_templates()`: Get a dictionary of all available templates.
- `is_valid_template(name)`: Verify if the specified template is valid.
- `find_user_templates()`: Find user-defined templates.

#### 8. Victims Class - Victim Management

**Function**: Manage victim devices connected to the rogue AP.

**Class Signature**:
```python
class Victims:
    @staticmethod
    def get_instance():
        """Get the singleton instance of Victims"""
    
    def add_to_victim_dic(self, victim_obj):
        """Add a victim to the dictionary"""
    
    def associate_victim_ip_to_os(self, ip_address, url):
        """Associate the operating system information based on the IP address"""
    
    def get_print_representation(self):
        """Get the print representation"""
```

**Main Methods**:
- `get_instance()`: Get the singleton instance.
- `add_to_victim_dic(victim_obj)`: Add a victim object to the dictionary.
- `associate_victim_ip_to_os(ip_address, url)`: Identify the operating system based on the User-Agent.
- `get_print_representation()`: Get the print format of the victim information, returning the last 5 victims.

**Attributes**:
- `victims_dic`: A dictionary of victims, with the MAC address as the key and the Victim object as the value.
- `url_file`: The file handle for operating system identification.

#### 9. Victim Class - Victim Object

**Function**: Represent the information of a single victim device.

**Class Signature**:
```python
class Victim:
    def __init__(self, vmac_address, ip_address):
        """Initialize the victim object"""
    
    def associate_victim_mac_to_vendor(self, vmac_address):
        """Associate the manufacturer information based on the MAC address"""
    
    def assign_ip_to_victim(self, vmac_address, ip_address):
        """Assign an IP address to the victim"""
```

**Attributes**:
- `vmac_address`: The MAC address of the victim.
- `ip_address`: The IP address of the victim.
- `os`: The operating system information.
- `vendor`: The device manufacturer information.
- `timestamp`: The connection timestamp.

#### 10. AccessPointFinder Class - Network Reconnaissance

**Function**: Discover and scan surrounding WiFi networks.

**Class Signature**:
```python
class AccessPointFinder:
    def __init__(self, ap_interface, network_manager):
        """Initialize the AP finder"""
    
    def find_all_access_points(self):
        """Discover all access points"""
    
    def stop_finding_access_points(self):
        """Stop AP discovery"""
    
    def get_sorted_access_points(self):
        """Get the sorted list of access points"""
```

**Main Methods**:
- `find_all_access_points()`: Start discovering all access points.
- `stop_finding_access_points()`: Stop the AP discovery process.
- `get_sorted_access_points()`: Get the list of APs sorted by signal strength.

#### 11. Fw Class - Firewall Management

**Function**: Manage iptables firewall rules.

**Class Signature**:
```python
class Fw:
    @staticmethod
    def nat(internal_interface, external_interface):
        """Configure NAT rules"""
    
    @staticmethod
    def clear_rules():
        """Clear all firewall rules"""
    
    @staticmethod
    def redirect_requests_localhost():
        """Redirect HTTP/HTTPS/DNS requests to the local host"""
```

**Main Methods**:
- `nat(internal_interface, external_interface)`: Configure network address translation.
- `clear_rules()`: Clear all iptables rules.
- `redirect_requests_localhost()`: Redirect traffic to the local server.

#### 12. MACMatcher Class - MAC Address Matching

**Function**: Match device manufacturer information based on the MAC address.

**Class Signature**:
```python
class MACMatcher:
    def __init__(self, mac_vendor_file):
        """Initialize the MAC matcher"""
    
    def get_vendor_name(self, mac_address):
        """Get the manufacturer name based on the MAC address"""
    
    def get_vendor_logo_path(self, mac_address):
        """Get the path of the manufacturer's logo based on the MAC address"""
```

**Main Methods**:
- `get_vendor_name(mac_address)`: Get the manufacturer name based on the MAC address.
- `get_vendor_logo_path(mac_address)`: Get the file path of the manufacturer's logo.

#### 13. OpMode Class - Operation Mode Management

**Function**: Manage different operation mode configurations.

**Class Signature**:
```python
class OpMode:
    def __init__(self):
        """Initialize the operation mode manager"""
    
    def initialize(self, args):
        """Initialize the operation mode"""
    
    def set_opmode(self, args, network_manager):
        """Set the operation mode"""
    
    def internet_sharing_enabled(self):
        """Check if Internet sharing is enabled"""
    
    def extensions_enabled(self):
        """Check if extensions are enabled"""
```

**Main Methods**:
- `initialize(args)`: Initialize the operation mode based on command-line arguments.
- `set_opmode(args, network_manager)`: Set the specific operation mode.
- `internet_sharing_enabled()`: Check if Internet sharing is enabled.
- `extensions_enabled()`: Check if extension modules are enabled.

### Extended Module API

#### 1. Deauth Class - Deauthentication Attack

**Function**: Execute a WiFi deauthentication attack.

**Class Signature**:
```python
class Deauth(object):
    """
    Handles all the deauthentication process.
    """

    def __init__(self, data):
        """
        Setup the class with all the given arguments.

        :param self: A Deauth object
        :param data: Shared data from main engine
        :type self: Deauth
        :type data: tuple
        :return: None
        :rtype: None
        """

        self._observed_clients = set()
        self._should_continue = True
        self._data = data
        # the bssids having the same ESSID
        self._deauth_bssids = dict()
        # channel mapping to the frames list
        self._packets_to_send = defaultdict(list)
    
    @staticmethod
    def _craft_packet(sender, receiver, bssid):
        """
        Return a list with disassociation packet followed by a
        deauthentication packet

        :param sender: The MAC address of the sender
        :param receiver: The MAC address of the receiver
        :param bssid: The MAC address of the AccessPoint
        :type sender: str
        :type receiver: str
        :type bssid: str
        :return: list
        :rtype: A list with disassociation followed by deauthentication packet
        """

    @staticmethod
    def _extract_bssid(packet):
        """
        Return the bssid of access point based on the packet type

        :param packet: A scapy.layers.RadioTap object
        :type packet: scapy.layers.RadioTap
        :return: bssid or None if it is WDS
        :rtype: str or None
        .. note: 0 0 -> IBBS
                 0 1 -> from AP
                 1 0 -> to AP
        """

    def _is_target(self, packet):
        """
        Check if this is the target attacking bssid
        :param self: A Deauth object
        :param packet: A scapy.layers.RadioTap object
        :type self: Deauth
        :type packet: scapy.layers.RadioTap
        :return: True if this is the target attacking bssid else False
        :rtype: bool
        """
    
    def get_packet(self, packet):
        """
        Process the Dot11 packets and add any desired clients to
        observed_clients.

        :param self: A Deauth object
        :param packet: A scapy.layers.RadioTap object
        :type self: Deauth
        :type packet: scapy.layers.RadioTap
        :return: A tuple with channel list followed by packets list
        :rtype: tuple
        """

    def _update_target_ap_frames(self, new_channel, old_channel, bssid):
        """
        :param self: A Deauth object
        :param new_channel: New channel for the target AP
        :param old_channel: Old channel for the target AP
        :type self: Deauth
        :param bssid: Address of the bssid
        :type new_channel: str
        :type old_channel: str
        :type bssid: str
        :return: None
        :rtype: None
        """

    def _add_clients(self, sender, receiver, bssid):
        """
        Return a tuple containing client followed by packets if the given
        packet is valid and return None otherwise

        :param self: A Deauth object
        :param sender: Address of the sender
        :param receiver: Address of the receiver
        :param bssid: Address of the bssid
        :type self: Deauth
        :type sender: str
        :type receiver: str
        :type bssid: str
        :return: (client: str, packets: list) or None
        :rtype: tuple or None
        """

    def send_output(self):
        """
        Get any relevant output message

        :param self: A Deauth object
        :type self: Deauth
        :return: A list with all the message entries
        :rtype: list
        """

    def send_channels(self):
        """
        Send channes to subscribe

        :param self: A Deauth object
        :type self: Deauth
        :return: A list with all interested channels
        :rtype: list
        """

    def on_exit(self):
        """
        Free all the resources regarding to this module
        :param self: A Deauth object
        :type self: Deauth
        :return: None
        :rtype: None
        """
        pass        

#### 2. Lure10 Class - Location Spoofing Attack

**Function**: Execute a Windows location service spoofing attack.

**Class Signature**:
```python
class Lure10:
    def __init__(self, data):
        """Initialize the location spoofing attack"""
    
    def get_packet(self, packet):
        """Process the packet and generate a location spoofing packet"""
    
    def send_output(self):
        """Send output information"""
```

#### 3. Knownbeacons Class - Known Beacons Attack

**Function**: Broadcast known network names to trigger automatic connections.

**Class Signature**:
```python
class Knownbeacons:
    def __init__(self, shared_data):
        """Initialize the known beacons attack"""
    
    def get_packet(self, pkt):
        """Generate a known beacons packet"""
    
    def send_output(self):
        """Send output information"""
```

#### 4. Wpspbc Class - WPS PBC Attack

**Function**: Execute a WPS PBC attack.

**Class Signature**:
```python
class Wpspbc:
    def __init__(self, data):
        """Initialize the WPS attack"""
    
    def get_packet(self, packet):
        """Process WPS-related packets"""
    
    def send_output(self):
        """Send output information"""
    
    @extensions.register_backend_funcs
    def get_wps_state_handler(self, *list_data):
        """WPS state handling function"""
```

#### 5. Handshakeverify Class - Handshake Verification

**Function**: Verify the WPA handshake capture file.

**Class Signature**:
```python
class Handshakeverify:
    def __init__(self, data):
        """Initialize the handshake verification"""
    
    @extensions.register_backend_funcs
    def psk_verify(self, *list_data):
        """Verify the pre-shared key"""
```

### Command-Line Argument API

#### Main Arguments

```python
# Interface selection arguments
-i, --interface              # Manually select an interface that supports AP and Monitor modes
-eI, --extensionsinterface   # Manually select an extension interface that supports Monitor mode
-aI, --apinterface          # Manually select an interface that supports AP mode
-iI, --internetinterface    # Select the interface connected to the Internet
-pI, --protectinterface     # Specify the protected interface
-mI, --mitminterface        # Select the interface for MITM attacks

# MAC address randomization
-iAM, --mac-ap-interface    # Specify the MAC address of the AP interface
-iEM, --mac-extensions-interface  # Specify the MAC address of the extension interface
-iNM, --no-mac-randomization     # Do not change any MAC addresses

# Attack configuration
-nE, --noextensions         # Do not load any extensions
-nD, --nodeauth             # Skip the deauthentication phase
-dC, --deauth-channels      # Specify the channels for deauthentication
-e, --essid                 # Specify the ESSID of the rogue AP
-dE, --deauth-essid         # Deauthenticate all BSSIDs of the specified ESSID
-p, --phishingscenario      # Select a phishing scenario
-pK, --presharedkey         # Add WPA/WPA2 protection to the rogue AP
-hC, --handshake-capture    # The WPA/WPA2 handshake capture file

# Advanced options
-kN, --keepnetworkmanager   # Do not kill the NetworkManager
-fH, --force-hostapd        # Force the use of the system hostapd
-lE, --lure10-exploit       # Enable the Lure10 location spoofing attack
-wP, --wps-pbc              # Enable the WPS PBC attack
-kB, --known-beacons        # Enable the known beacons attack
```

### Practical Usage Modes

#### Basic Usage

```python
from wifiphisher.pywifiphisher import WifiphisherEngine

# Create and start the WiFiPhisher engine
engine = WifiphisherEngine()
try:
    engine.start()
except KeyboardInterrupt:
    engine.stop()
```

#### Victim Management Usage

```python
from wifiphisher.common.victim import Victims, Victim

# Get the victim manager
victims = Victims.get_instance()

# Create a victim object
victim = Victim("AA:BB:CC:DD:EE:FF", "10.0.0.100")
victim.associate_victim_mac_to_vendor("AA:BB:CC:DD:EE:FF")

# Add to the victim dictionary
victims.add_to_victim_dic(victim)

# Identify the operating system based on the User-Agent
victims.associate_victim_ip_to_os("10.0.0.100", 
    "http://connectivitycheck.android.com/generate_204/")

# Get victim information
victim_info = victims.get_print_representation()
print(f"Victim information: {victim_info}")
```

#### Custom Configuration Usage

```python
from wifiphisher.pywifiphisher import WifiphisherEngine
from wifiphisher.common.accesspoint import AccessPoint
from wifiphisher.common.extensions import ExtensionManager
from wifiphisher.common.interfaces import NetworkManager

# Create a custom configuration
engine = WifiphisherEngine()

# Configure the rogue AP
ap = AccessPoint.get_instance()
ap.essid = "Free WiFi"
ap.channel = "6"
ap.presharedkey = "password123"

# Configure the network manager
nm = NetworkManager()
nm.internet_access_enable = True

# Configure the extension manager
em = ExtensionManager(nm)
em.set_extensions(["deauth", "knownbeacons"])
em.init_extensions(shared_data)
em.start_extensions()

# Start the attack
engine.start()
```

#### Network Interface Management Usage

```python
from wifiphisher.common.interfaces import NetworkManager, NetworkAdapter

# Create a network manager
nm = NetworkManager()

# Create a network adapter
adapter = NetworkAdapter("wlan0", "CARD", "00:00:00:00:00:00")
adapter.has_ap_mode = True
adapter.has_monitor_mode = True

# Get an interface that supports AP and Monitor modes
interface = nm.get_interface(has_ap_mode=True, has_monitor_mode=True)

# Set the interface mode
nm.set_interface_mode("wlan0", "monitor")

# Set MAC address randomization
nm.set_interface_mac("wlan0")

# Enable the interface
nm.up_interface("wlan0")

# Set the channel
nm.set_interface_channel("wlan0", 6)
```

#### Network Reconnaissance Usage

```python
from wifiphisher.common.recon import AccessPointFinder
from wifiphisher.common.interfaces import NetworkManager

# Create a network manager
nm = NetworkManager()

# Create an AP finder
finder = AccessPointFinder("wlan0", nm)
finder.find_all_access_points()

# Get the list of discovered APs
aps = finder.get_sorted_access_points()
for ap in aps:
    print(f"SSID: {ap.name}, BSSID: {ap.mac_address}, Channel: {ap.channel}")
```

#### Extended System Usage

```python
from wifiphisher.common.extensions import ExtensionManager
from wifiphisher.extensions.deauth import Deauth
from wifiphisher.extensions.lure10 import Lure10
from collections import namedtuple

# Create an extension manager
nm = NetworkManager()
em = ExtensionManager(nm)

# Set the list of extensions
extensions = ["deauth", "lure10", "knownbeacons"]
em.set_extensions(extensions)

# Prepare shared data
TestData = namedtuple("test", "target_ap_bssid target_ap_channel rogue_ap_mac args target_ap_essid is_freq_hop_allowed")
shared_data = TestData("BB:BB:BB:BB:BB:BB", "6", "CC:CC:CC:CC:CC:CC", args, "Evil", True)

# Initialize the extensions
em.init_extensions(shared_data)

# Start the extensions
em.start_extensions()

# Get the output of the extensions
output = em.get_output()
channels = em.get_channels()

# Get UI methods
ui_funcs = em.get_ui_funcs()

# Get backend methods
backend_funcs = em.get_backend_funcs()
```

#### Victim Management Usage

```python
from wifiphisher.common.victim import Victims, Victim

# Get the victim manager
victims = Victims.get_instance()

# Create a victim object
victim = Victim("AA:BB:CC:DD:EE:FF", "10.0.0.100")
victim.associate_victim_mac_to_vendor("AA:BB:CC:DD:EE:FF")

# Add to the victim dictionary
victims.add_to_victim_dic(victim)

# Identify the operating system based on the User-Agent
victims.associate_victim_ip_to_os("10.0.0.100", 
    "http://connectivitycheck.android.com/generate_204/")

# Get victim information
victim_info = victims.get_print_representation()
print(f"Victim information: {victim_info}")
```

#### Phishing Template Usage

```python
from wifiphisher.common.phishingpage import TemplateManager, PhishingTemplate

# Create a template manager
tm = TemplateManager()

# Get all templates
templates = tm.get_templates()

# Create a specific template
template = PhishingTemplate("firmware-upgrade")
print(f"Template name: {template.get_display_name()}")
print(f"Template description: {template.get_description()}")
print(f"Template path: {template.get_path()}")
print(f"Template context: {template.get_context()}")
print(f"Is there a payload: {template.has_payload()}")
```

#### Deauthentication Attack Usage

```python
from wifiphisher.extensions.deauth import Deauth
from collections import namedtuple
import mock

# Prepare test data
TestData = namedtuple("test", "target_ap_bssid target_ap_channel rogue_ap_mac args target_ap_essid is_freq_hop_allowed")
args = mock.Mock()
args.deauth_essid = False
args.channel_monitor = False
args.deauth_channels = []

data = TestData("BB:BB:BB:BB:BB:BB", "6", "CC:CC:CC:CC:CC:CC", args, "Evil", True)

# Create a deauthentication attack object
deauth_obj = Deauth(data)

# Construct attack packets
sender = "00:00:00:00:00:00"
receiver = "11:11:11:11:11:11"
bssid = "00:00:00:00:00:00"

packets = deauth_obj._craft_packet(sender, receiver, bssid)
print(f"Number of constructed packets: {len(packets)}")  # Should return 2 packets: disassociation + deauthentication

# Verify the packet types
assert packets[0].subtype == 10  # disassociation
assert packets[1].subtype == 12  # deauthentication
```

### Supported Attack Types

- **Evil Twin Attack**: Create a fake AP identical to the target network.
- **KARMA Attack**: Respond to clients' probe requests.
- **Known Beacons Attack**: Broadcast known network names.
- **Deauth Attack**: Send deauthentication packets.
- **Lure10 Attack**: Windows location service spoofing.
- **WPS PBC Attack**: WPS PBC attack.
- **Handshake Verification**: WPA/WPA2 handshake verification.

### Error Handling

The system provides a comprehensive error handling mechanism:
- **Interface Verification**: Check the validity and mode support of network interfaces.
- **Permission Check**: Verify root permissions and system dependencies.
- **Resource Cleanup**: Automatically clean up all resources when the program exits.
- **Exception Capture**: Gracefully handle various exception situations.

### Important Notes

1. **Permission Requirements**: It needs to be run with root permissions because it requires direct operation of network interfaces.
2. **Hardware Requirements**: A wireless network card that supports AP and Monitor modes is required.
3. **Legal Compliance**: It should only be used for authorized security testing, and explicit authorization for the target network is required.
4. **System Dependencies**: System tools such as dnsmasq and hostapd need to be installed.
5. **Network Isolation**: It is recommended to test in an isolated environment to avoid affecting the production network.

### API Usage Guide Update Instructions

#### Summary of Update Content

**✅ Fixed Errors**:
1. **Network Configuration Constants**: Corrected NETWORK_GW_IP from "192.168.1.1" to "10.0.0.1".
2. **Network IP Address**: Corrected NETWORK_IP from "192.168.1.0" to "10.0.0.0".
3. **Port Configuration**: Corrected PORT from 80 to 8080.
4. **DHCP Lease**: Corrected the format and address range of DHCP_LEASE.

**✅ Added API Methods**:
1. **ExtensionManager Class**:
   - `get_ui_funcs()` - Get the list of UI methods.
   - `get_backend_funcs()` - Get the dictionary of backend methods.
   - `set_interface(interface)` - Set the interface.
   - `get_channels()` - Get the channel information.

2. **NetworkManager Class**:
   - `get_interface_automatically()` - Automatically get an interface.
   - `get_interface_mac(interface_name)` - Get the MAC address.
   - `set_interface_channel(interface_name, channel)` - Set the channel.
   - `unblock_interface(interface_name)` - Unblock the interface.
   - `add_virtual_interface(card)` - Add a virtual interface.
   - `remove_vifs_added()` - Remove the added virtual interfaces.
   - `nm_unmanage(interface)` - Cancel the management of the NetworkManager.
   - `is_interface_valid(interface_name, mode)` - Verify the interface.
   - `start(args)` - Start the manager.
   - `on_exit()` - Clean up resources.

**✅ Improved Usage Examples**:
1. **Victim Management**: Added a complete example of victim creation, management, and operating system identification.
2. **Network Interface Management**: Added examples of interface configuration, mode switching, and MAC address management.
3. **Extended System**: Added a complete usage example of the extension manager.
4. **Deauthentication Attack**: Added examples of packet construction and verification.

**✅ Verified Test Cases**:
- 41 test cases verified the correctness of the core API.
- Covered main functions such as victim management, deauthentication attacks, and Lure10 attacks.
- All test cases are based on actual code implementations.

#### Usage Recommendations

1. **Module Import**: Import using the full module path, such as `from wifiphisher.common.victim import Victims`.
2. **Error Handling**: All API calls should include appropriate exception handling.
3. **Resource Cleanup**: Call the corresponding `on_exit()` method to clean up resources after use.
4. **Test Verification**: Refer to the usage in the test files to ensure correct API calls.

## Detailed Function Implementation Nodes

### Node 1: Victim Management System (Victim Management)

**Function Description**: Manage victim devices connected to the rogue AP, including victim object creation, IP address assignment, operating system identification, and device tracking.

**Core Algorithms**:
- Victim object management.
- Dynamic IP address assignment.
- User-Agent operating system identification.
- Persistent storage of victim information.
- Device connection status tracking.

**Input/Output Example**:

```python
from wifiphisher.common.victim import Victims, Victim

# Create a victim object
victim = Victim("68:CC:6E:23:44:53", "10.0.0.5")
victims = Victims.get_instance()

# Add the victim to the dictionary
victims.add_to_victim_dic(victim)

# Verify victim information
assert "68:CC:6E:23:44:53" in victims.victims_dic
assert victims.victims_dic["68:CC:6E:23:44:53"].ip_address == "10.0.0.5"

# Update the victim's IP address (must get existing victim first)
existing_victim = victims.victims_dic["68:CC:6E:23:44:53"]
existing_victim.assign_ip_to_victim("68:CC:6E:23:44:53", "10.0.0.10")
assert victims.victims_dic["68:CC:6E:23:44:53"].ip_address == "10.0.0.10"

# Operating system identification
victims.associate_victim_ip_to_os("10.0.0.5", 
    "http://connectivitycheck.android.com/generate_204/gener/plox/")
assert victims.victims_dic["68:CC:6E:23:44:53"].os == "Android"

victims.associate_victim_ip_to_os("10.0.0.6", 
    "http://msftncsi.com/lalala/loulou/sasasas.php")
assert victims.victims_dic["5C:BA:37:23:44:53"].os == "Windows"

# Get victim information
victim_info = victims.get_print_representation()
print(f"Victim information: {victim_info}")
```

### Node 2: MAC Address Matching System (MAC Address Matching)

**Function Description**: Match device manufacturer information based on the MAC address, providing functions for querying the manufacturer name and logo path.

**Core Algorithms**:
- MAC address prefix matching.
- Manufacturer database query.
- Logo file path parsing.
- Manufacturer information caching.

**Input/Output Example**:

```python
from wifiphisher.common.macmatcher import MACMatcher

# Create a MAC matcher
mac_matcher = MACMatcher("wifiphisher/data/wifiphisher-mac-prefixes")

# MAC address matching test
vendor = mac_matcher.get_vendor_name("68:CC:6E:23:44:53")
assert vendor == "Huawei Technologies"

vendor = mac_matcher.get_vendor_name("5C:BA:37:23:44:53")
assert vendor == "Microsoft"

# Get the manufacturer's logo path
logo_path = mac_matcher.get_vendor_logo_path("68:CC:6E:23:44:53")
assert logo_path is not None
assert logo_path.endswith(".png")

# Associate the victim's MAC with the manufacturer
victim.associate_victim_mac_to_vendor("68:CC:6E:23:44:53")
assert victims.victims_dic["68:CC:6E:23:44:53"].vendor == "Huawei Technologies"
```

### Node 3: WiFi Attack Extension System (WiFi Attack Extensions)

**Function Description**: Implement various WiFi attack extension modules, including deauthentication attacks, location spoofing attacks, known beacons attacks, WPS PBC attacks, etc.

**Attack Mechanisms**:
- Deauthentication attack (Deauth):
  - Targeted deauth: Attack specific client-AP pairs
  - Broadcast deauth: Attack ALL clients connected to an AP simultaneously using broadcast address (ff:ff:ff:ff:ff:ff)
  - Both disassociation (subtype 10) and deauthentication (subtype 12) packets
- Location spoofing attack (Lure10).
- Known beacons attack (Known Beacons).
- WPS PBC attack (WPS PBC).
- Packet construction and processing.
- Attack status management.

**Input/Output Example**:

```python
from wifiphisher.extensions.deauth import Deauth
from wifiphisher.extensions.lure10 import Lure10
from wifiphisher.extensions.knownbeacons import Knownbeacons
from wifiphisher.extensions.wpspbc import Wpspbc
from collections import namedtuple
import mock

# Test the Deauth attack
TestData = namedtuple("test", "target_ap_bssid target_ap_channel rogue_ap_mac args target_ap_essid is_freq_hop_allowed")
args = mock.Mock()
args.deauth_essid = False
args.channel_monitor = False
args.deauth_channels = []

data = TestData("BB:BB:BB:BB:BB:BB", "6", "CC:CC:CC:CC:CC:CC", args, "Evil", True)
deauth_obj = Deauth(data)

# Test packet construction
sender = "00:00:00:00:00:00"
receiver = "11:11:11:11:11:11"
bssid = "00:00:00:00:00:00"

packets = deauth_obj._craft_packet(sender, receiver, bssid)
assert len(packets) == 2  # disassociation + deauthentication

# Verify the disassociation packet
assert packets[0].subtype == 10
assert packets[0].addr1 == receiver
assert packets[0].addr2 == sender
assert packets[0].addr3 == bssid

# Verify the deauthentication packet
assert packets[1].subtype == 12
assert packets[1].addr1 == receiver
assert packets[1].addr2 == sender
assert packets[1].addr3 == bssid

# Test broadcast deauthentication attack (attacks all clients simultaneously)
from wifiphisher.common import constants
import scapy.all as scapy
from scapy.layers import dot11

# Create a test beacon packet to trigger broadcast attack
sender = "00:00:00:00:00:00"
receiver = "11:11:11:11:11:11" 
target_bssid = "BB:BB:BB:BB:BB:BB"

# Construct beacon packet
essid = dot11.Dot11Elt(ID='SSID', info="")
rates = dot11.Dot11Elt(ID='Rates', info="\x03\x12\x96\x18\x24\x30\x48\x60")
dsset = dot11.Dot11Elt(ID='DSset', info='\x06')
test_packet = dot11.RadioTap() / dot11.Dot11() / dot11.Dot11Beacon() / essid / rates / dsset

test_packet.addr1 = receiver
test_packet.addr2 = sender  
test_packet.addr3 = target_bssid
test_packet.FCfield = 0x0

# Test broadcast attack using get_packet method
broadcast_packets = deauth_obj.get_packet(test_packet)
target_channel = int(data.target_ap_channel)

# Verify broadcast packets are generated for the target channel
assert target_channel in broadcast_packets
result_packets = broadcast_packets[target_channel]

# Check disassociation packet (subtype 10) - sent to broadcast address
assert result_packets[0].subtype == 10
assert result_packets[0].addr1 == constants.WIFI_BROADCAST  # ff:ff:ff:ff:ff:ff - targets ALL clients
assert result_packets[0].addr2 == target_bssid  # From the target AP
assert result_packets[0].addr3 == target_bssid

# Check deauthentication packet (subtype 12) - sent to broadcast address  
assert result_packets[1].subtype == 12
assert result_packets[1].addr1 == constants.WIFI_BROADCAST  # ff:ff:ff:ff:ff:ff - targets ALL clients
assert result_packets[1].addr2 == target_bssid  # From the target AP
assert result_packets[1].addr3 == target_bssid

print(f"Broadcast attack targets ALL clients with address: {constants.WIFI_BROADCAST}")
print("This effectively disconnects ALL devices from the target AP simultaneously")

# Test send_output method (shows attack results to user)
# Test when no clients are detected
output_empty = deauth_obj.send_output()
assert output_empty == []  # Should be empty list when no clients

# Test when clients are detected (need to simulate client detection first)
test_sender = "44:44:44:44:44:44"
test_receiver = "55:55:55:55:55:55"
test_bssid = test_receiver

# Create a data packet to simulate client communication
test_packet = dot11.RadioTap() / dot11.Dot11() / dot11.Dot11QoS()
test_packet.addr1 = test_receiver
test_packet.addr2 = test_sender  
test_packet.addr3 = test_bssid

# Add the BSSID to deauth targets and simulate packet processing
deauth_obj._deauth_bssids[test_bssid] = data.target_ap_channel
deauth_obj.get_packet(test_packet)

# Now send_output should return information about detected clients
output_with_clients = deauth_obj.send_output()
expected_output = f"DEAUTH/DISAS - {test_sender}"
assert len(output_with_clients) > 0
assert output_with_clients[0] == expected_output
print(f"Deauth output: {output_with_clients}")

# Test the Lure10 attack
TestData = namedtuple("test", "args target_ap_channel")
TestArgs = namedtuple("test1", "lure10_exploit")
args = TestArgs("test")
data = TestData(args, 6)

lure10_obj = Lure10(data)
packets = lure10_obj.get_packet(None)
assert packets["*"][0].subtype == 8  # Beacon frame
assert packets["*"][0].addr1 == "ff:ff:ff:ff:ff:ff"  # Broadcast address

# Test the Known Beacons attack
beacons_obj = Knownbeacons(shared_data)
packet = mock.Mock()
result = beacons_obj.get_packet(packet)
assert isinstance(result, dict)

output = beacons_obj.send_output()
assert "Known Beacons" in output[0]

# Test the WPS attack
TestData = namedtuple("test", "args target_ap_channel rogue_ap_mac")
args = mock.Mock()
data = TestData(args, "6", "CC:CC:CC:CC:CC:CC")

wps_obj = Wpspbc(data)
packet = mock.Mock()
result = wps_obj.get_packet(packet)
assert isinstance(result, dict)
```

### Node 4: Extension Manager System (Extension Manager)

**Function Description**: Manage the loading, initialization, and coordination of various WiFi attack extension modules, providing a modular architecture.

**Core Functions**:
- Extension module loading.
- Extension initialization management.
- Extension coordination and scheduling.
- Output information collection.
- Channel information management.
- UI method and backend method management.

**Input/Output Example**:

```python
from wifiphisher.common.extensions import ExtensionManager
from wifiphisher.common.interfaces import NetworkManager
from collections import namedtuple
import mock

# Create an extension manager (as used in tests)
from wifiphisher.common import constants
from scapy.layers import dot11
import mock

nm = NetworkManager()
em = ExtensionManager(nm)

# Use default extensions (only "deauth" by default)
em.set_extensions(constants.DEFAULT_EXTENSIONS)
assert constants.DEFAULT_EXTENSIONS == ["deauth"]

# Prepare shared data as in actual tests
shared_data = {"one": 1, "two": 2, "is_freq_hop_allowed": True}
em.init_extensions(shared_data)

# Simulate packet processing (as done in test_extensions.py)
# Create a deauth packet that appears in the air
packet = (
    dot11.RadioTap() /
    dot11.Dot11(
        type=0,
        subtype=12,  # Deauth packet
        addr1="00:00:00:00:00:00",
        addr2="00:00:00:00:00:00",
        addr3="00:00:00:00:00:00") /
    dot11.Dot11Deauth())

# Process the packet (this would trigger extension processing)
em._process_packet(packet)

# Get the output information (extension outputs)
output = em.get_output()
print(f"Extension outputs: {output}")

# Get the channel information
channels = em.get_channels()
print(f"Channels to hop: {channels}")

# Get the UI methods
ui_funcs = em.get_ui_funcs()
print(f"Number of UI methods: {len(ui_funcs)}")

# Get the backend methods
backend_funcs = em.get_backend_funcs()
print(f"Number of backend methods: {len(backend_funcs)}")

# Check packets to send (internal state)
print(f"Packets to send: {dict(em._packets_to_send)}")

# Clean up resources
em.on_exit()
```

### Node 5: Network Interface Management System (Network Interface Management)

**Function Description**: Manage wireless network interfaces, including interface mode switching, MAC address randomization, virtual interface creation, and integration with the NetworkManager.

**Core Functions**:
- Interface mode detection and switching (AP/Monitor/Managed).
- MAC address management and randomization.
- Virtual interface creation and deletion.
- Integration with the NetworkManager.
- Interface verification and acquisition.
- Channel setting and management.

**Input/Output Example**:

```python
from wifiphisher.common.interfaces import NetworkAdapter, NetworkManager

# Create a network adapter
adapter = NetworkAdapter("wlan0", "CARD", "00:00:00:00:00:00")

# Test basic attributes
assert adapter.name == "wlan0"
assert adapter.card == "CARD"
assert adapter.mac_address == "00:00:00:00:00:00"

# Test mode support
adapter.has_ap_mode = True
assert adapter.has_ap_mode == True

adapter.has_monitor_mode = True
assert adapter.is_managed_by_nm == False

# Test MAC address management
adapter.mac_address = "AA:BB:CC:DD:EE:FF"
assert adapter.mac_address == "AA:BB:CC:DD:EE:FF"
assert adapter.original_mac_address == "00:00:00:00:00:00"

# Test the NetworkManager
nm = NetworkManager()
nm.internet_access_enable = True
assert nm.internet_access_enable == True

# Test interface verification
assert nm.is_interface_valid("wlan0", mode="ap") == True
assert nm.is_interface_valid("wlan0", mode="monitor") == True

# Test interface acquisition
interface = nm.get_interface(has_ap_mode=True, has_monitor_mode=True)
assert interface is not None

# Test interface mode setting
nm.set_interface_mode("wlan0", "monitor")
nm.set_interface_channel("wlan0", 6)

# Test MAC address randomization
nm.set_interface_mac("wlan0")  # Randomize the MAC address

# Test virtual interface management
nm.add_virtual_interface(card)
nm.remove_vifs_added()

# Test interface status management
nm.up_interface("wlan0")
nm.down_interface("wlan0")

# Test utility functions for interface property detection
from wifiphisher.common.interfaces import interface_property_detector, is_managed_by_network_manager, is_wireless_interface

# Detect interface properties
interface_property_detector(adapter)
assert adapter.has_ap_mode == True
assert adapter.has_monitor_mode == True

# Check NetworkManager management status
is_managed = is_managed_by_network_manager("wlan0")
print(f"Interface wlan0 managed by NetworkManager: {is_managed}")

# Check if interface is wireless
is_wireless = is_wireless_interface("wlan0")
assert is_wireless == True

# Test exception handling
from wifiphisher.common.interfaces import InvalidValueError, InvalidInterfaceError

try:
    adapter.has_ap_mode = "invalid_value"  # Should raise InvalidValueError
except InvalidValueError as e:
    print(f"Caught expected error: {e}")

try:
    nm.is_interface_valid("non_existent_interface")  # Should raise InvalidInterfaceError  
except InvalidInterfaceError as e:
    print(f"Caught expected error: {e}")
```

### Node 7: Constants Definition System (Constants Definition)

**Function Description**: Manage all constants and global variables used in the project, including network configurations, file paths, system parameters, and channel lists.

**Value**:

```python
# wifiphisher.common.globals
ALL_2G_CHANNELS = list(range(1, 14))

# wifiphisher.common.constants
# Basic configuration
DEV = 1
DEAUTH_EXTENSION = "deauth"
LURE10_EXTENSION = "lure10"
WPSPBC = "wpspbc"
KNOWN_BEACONS_EXTENSION = "knownbeacons"
HANDSHAKE_VALIDATE_EXTENSION = "handshakeverify"
ROGUEHOSTAPDINFO = "roguehostapdinfo"
DEFAULT_EXTENSIONS = [DEAUTH_EXTENSION]
EXTENSIONS_LOADPATH = "wifiphisher.extensions."
PORT = 8080
SSL_PORT = 443
CHANNEL = 6
WEBSITE = "https://wifiphisher.org"
PUBLIC_DNS = "8.8.8.8"
PEM = dir_of_data + 'cert/server.pem'
SCENARIO_HTML_DIR = "html/"
LOGOS_DIR = dir_of_data + "logos/"
LOCS_DIR = dir_of_data + "locs/"
MAC_PREFIX_FILE = dir_of_data + "wifiphisher-mac-prefixes"
URL_TO_OS_FILE = dir_of_data + "wifiphisher-os-initial-requests"
KNOWN_WLANS_FILE = dir_of_data + "wifiphisher-known-open-wlans"
POST_VALUE_PREFIX = "wfphshr"
NETWORK_IP = "10.0.0.0"
NETWORK_MASK = "255.255.255.0"
NETWORK_GW_IP = "10.0.0.1"
DHCP_LEASE = "10.0.0.2,10.0.0.100,12h"
WIFI_BROADCAST = "ff:ff:ff:ff:ff:ff"
WIFI_INVALID = "00:00:00:00:00:00"
WIFI_IPV6MCAST1 = "33:33:00:"
WIFI_IPV6MCAST2 = "33:33:ff:"
WIFI_SPANNINGTREE = "01:80:c2:00:00:00"
WIFI_MULTICAST = "01:00:5e:"
NON_CLIENT_ADDRESSES = set([
    WIFI_BROADCAST, WIFI_INVALID, WIFI_MULTICAST, WIFI_IPV6MCAST1,
    WIFI_IPV6MCAST2, WIFI_SPANNINGTREE, None
])
DEFAULT_OUI = '00:00:00'
LINES_OUTPUT = 3
DN = open(os.devnull, 'w')
INTERFERING_PROCS = [
    "wpa_action", "wpa_supplicant", "wpa_cli", "dhclient", "ifplugd", "dhcdbd",
    "dhcpcd", "udhcpc", "avahi-autoipd", "avahi-daemon", "wlassistant",
    "wifibox", "NetworkManager", "knetworkmanager"
]
DNS_CONF_PATH = '/tmp/dnsmasq.conf'
NEW_YEAR = "01-01"
BIRTHDAY = "01-05"

# Modes of operation
# AP, Extensions
# 2 cards, 2 interfaces
# i) AP, ii) EM
OP_MODE1 = 0x1
# AP, Extensions and Internet
# 3 cards, 3 interfaces
# i) AP, ii) EM iii) Internet
OP_MODE2 = 0x2
# AP-only and Internet
# 2 cards, 2 interfaces
# i) AP, ii) Internet
OP_MODE3 = 0x3
# AP-only
# 1 card, 1 interface
# i) AP
OP_MODE4 = 0x4
# AP, Extensions w/ 1 vif
# 1 card, 2 interfaces
# i) AP, ii) Extensions
OP_MODE5 = 0x5
# AP, Extensions and Internet w/ 1 vif
# 2 cards, 3 interfaces
# i) AP, ii) Extensions, iii) Internet
OP_MODE6 = 0x6
# Advanced and WPS association 0x7
#  3 cards, 3 interfaces
#  i) AP, ii) Extensions, iii) Extensions (Managed)
OP_MODE7 = 0x7

# Advanced and WPS association w/ 1 vif support AP/Monitor 0x8
# 2 cards, 3 interfaces
# i) AP, ii) Extensions, iii) Extensions (Managed)
OP_MODE8 = 0x8

AP_RATES = "\x0c\x12\x18\x24\x30\x48\x60\x6c"

# Console colors
W = '\033[0m'  # white (normal)
R = '\033[31m'  # red
G = '\033[32m'  # green
O = '\033[33m'  # orange
B = '\033[34m'  # blue
P = '\033[35m'  # purple
C = '\033[36m'  # cyan
GR = '\033[37m'  # gray
T = '\033[93m'  # tan

# Logging configurations
# possible values for debug levels are:
# CRITICAL, ERROR, WARNING, INFO, DEBUG, NOTSET
LOG_LEVEL = 'INFO'
LOG_FILEPATH = 'wifiphisher.log'
LOGGING_CONFIG = {
    'version': 1,
    # Defined the handlers
    'handlers': {
        'file': {
            'class': 'logging.handlers.RotatingFileHandler',
            'level': LOG_LEVEL,
            'formatter': 'detailed',
            'filename': LOG_FILEPATH,
            'backupCount': 3,
        },
    },
    # fomatters for the handlers
    'formatters': {
        'detailed': {
            'format': '%(asctime)s - %(name) 32s - %(levelname)s - %(message)s'
        },
    },
    'root': {
        'level': 'DEBUG',
        'handlers': [
            'file',
        ],
    },
    "loggers": {},
    'disable_existing_loggers': False
}
CREDENTIALS_DATETIME_FORMAT = '%Y-%m-%d %H:%M:%S'

# Phishinghttp
VALID_POST_CONTENT_TYPE = "application/x-www-form-urlencoded"
REGEX_PWD = "password|pwd|pass"
REGEX_UNAME = "username|uname|name"

# TUI
MAIN_TUI_ATTRS = 'version essid channel ap_iface em phishinghttp args'
AP_SEL_ATTRS = 'interface mac_matcher network_manager args'

# Fourway handshake extension
CONST_A = "Pairwise key expansion"

# Rogue AP related
DENY_MACS_PATH = '/tmp/hostapd.deny'

# Known Beacons
KB_INTERVAL = 20
KB_BUCKET_SIZE = 60
KB_BEACON_CAP = 0x2105
```

### Node 7: Rogue Access Point Management System (Rogue Access Point Management System)

**Function Description**: Create and manage fake WiFi access points, including DHCP servers, DNS servers, and network configurations, implementing the complete functionality of a rogue AP.

**Core Algorithms**:
- Singleton pattern management.
- DHCP server configuration and startup.
- DNS server configuration and startup.
- Network interface configuration.
- Routing table management.
- Rogue AP lifecycle management.

**Input/Output Example**:

```python
from wifiphisher.common.accesspoint import AccessPoint

# Get the singleton instance
ap = AccessPoint.get_instance()

# Configure AP parameters
ap.interface = "wlan0"
ap.internet_interface = "eth0"
ap.channel = "6"
ap.essid = "Free WiFi"
ap.presharedkey = "password123"
ap.force_hostapd = False

# Start the DHCP and DNS servers
ap.start_dhcp_dns()

# Start the rogue AP
ap.start(disable_karma=False)

# Read connected victims
victims = ap.read_connected_victims_file()

# Clean up resources
ap.on_exit()
```

### Node 8: Phishing Page Management System (Phishing Page Management System)

**Function Description**: Manage phishing page templates, supporting dynamic content generation, template verification, and user-defined templates, providing a complete phishing page service.

**Core Algorithms**:
- Template configuration parsing.
- Dynamic content generation.
- Template verification mechanism.
- User template management.
- Payload file processing.
- Context data merging.

**Input/Output Example**:

```python
from wifiphisher.common.phishingpage import PhishingTemplate, TemplateManager

# Create a template manager
tm = TemplateManager()

# Get all templates
templates = tm.get_templates()
print(f"Available templates: {list(templates.keys())}")

# Create a specific template
template = PhishingTemplate("firmware-upgrade")
print(f"Template name: {template.get_display_name()}")
print(f"Template description: {template.get_description()}")
print(f"Template path: {template.get_path()}")
print(f"Static file path: {template.get_path_static()}")
print(f"Is there a payload: {template.has_payload()}")

# Get the template context
context = template.get_context()
print(f"Template context: {context}")

# Merge context data
template.merge_context({"custom_key": "custom_value"})

# Verify the template
is_valid = tm.is_valid_template("firmware-upgrade")
print(f"Is the template valid: {is_valid}")

# Find user templates
user_templates = tm.find_user_templates()
print(f"User templates: {user_templates}")

# Add user templates
tm.add_user_templates()

# Clean up resources
tm.on_exit()
```

### Node 9: Network Reconnaissance System (Network Reconnaissance System)

**Function Description**: Discover and scan surrounding WiFi networks, including AP information collection, client detection, and signal strength analysis, providing support for attack target selection.

**Core Algorithms**:
- Packet sniffing and parsing.
- AP information extraction and storage.
- Client discovery and tracking.
- Signal strength calculation.
- Channel hopping management.
- Hidden network detection.

**Input/Output Example**:

```python
from wifiphisher.common.recon import AccessPointFinder, AccessPoint
from wifiphisher.common.interfaces import NetworkManager

# Create an AP finder
nm = NetworkManager()
finder = AccessPointFinder("wlan0", nm)

# Start discovering APs
finder.find_all_access_points()

# Get the list of discovered APs
aps = finder.get_sorted_access_points()
for ap in aps:
    print(f"SSID: {ap.name}")
    print(f"BSSID: {ap.mac_address}")
    print(f"Channel: {ap.channel}")
    print(f"Encryption: {ap.encryption}")
    print(f"Signal strength: {ap.signal_strength}")
    print(f"Client count: {ap.client_count}")
    print("---")

# Create an AP object
ap_obj = AccessPoint("TestSSID", "AA:BB:CC:DD:EE:FF", "6", "WPA2", capture_file="capture.txt")

# Add a client
ap_obj.add_client("11:22:33:44:55:66")
print(f"Client count: {ap_obj.client_count}")

# Stop discovery
finder.stop_finding_access_points()
```

### Node 10: Firewall Management System (Firewall Management System)

**Function Description**: Manage iptables firewall rules, implementing NAT configuration, traffic redirection, and rule cleaning to ensure correct routing of network traffic.

**Core Algorithms**:
- NAT rule configuration.
- Traffic redirection.
- Rule cleaning.
- Port forwarding.
- Network isolation.

**Input/Output Example**:

```python
from wifiphisher.common.firewall import Fw

# Configure NAT rules
Fw.nat("wlan0", "eth0")

# Redirect HTTP/HTTPS/DNS requests to the local host
Fw.redirect_requests_localhost()
# Redirection details:
# - HTTP (Port 80) -> Local:8080
# - HTTPS (Port 443) -> Local:443
# - DNS (Port 53) -> Local:53

# Clean up all iptables rules
Fw.clear_rules()
# Cleanup details:
# - iptables -F (Empty the filter table)
# - iptables -X (Delete custom chains)
# - iptables -t nat -F (Empty the nat table)
# - iptables -t nat -X (Delete custom chains in the nat table)

# Create a firewall instance and clean up resources
fw = Fw()
fw.on_exit()
```

### Node 11: Operation Mode Management System (Operation Mode Management System)

**Function Description**: Manage different operation mode configurations, automatically selecting the optimal mode based on hardware resources and user parameters, and supporting various attack scenarios.

**Core Algorithms**:
- Parameter verification and conflict checking.
- Mode selection logic.
- Hardware resource detection.
- Configuration optimization.
- Mode status management.

**Input/Output Example**:

```python
from wifiphisher.common.opmode import OpMode

# Create an operation mode manager
opmode = OpMode()

# Initialize the operation mode
opmode.initialize(args)

# Set the operation mode
opmode.set_opmode(args, network_manager)

# Check the enable status of various functions
internet_enabled = opmode.internet_sharing_enabled()
print(f"Internet sharing enabled: {internet_enabled}")

extensions_enabled = opmode.extensions_enabled()
print(f"Extension functions enabled: {extensions_enabled}")

freq_hopping_enabled = opmode.freq_hopping_enabled()
print(f"Frequency hopping enabled: {freq_hopping_enabled}")

assoc_enabled = opmode.assoc_enabled()
print(f"Association function enabled: {assoc_enabled}")

# Verify the AP interface
from wifiphisher.common.opmode import validate_ap_interface
is_valid = validate_ap_interface("wlan0")
print(f"Is the AP interface valid: {is_valid}")
```

### Node 12: User Interface System (Text User Interface System)

**Function Description**: Provide a text user interface based on curses, supporting AP selection, template selection, and main interface display, providing a friendly interaction experience.

**Core Algorithms**:
- Interface layout management.
- Keyboard event handling.
- Paging display.
- Real-time information update.
- Window size adaptation.

**Input/Output Example**:

```python
from wifiphisher.common.tui import TuiApSel, TuiTemplateSelection, TuiMain

# AP selection interface
ap_sel = TuiApSel()
ap_info = ap_sel.gather_info(screen, info)
ap_sel.display_access_points(screen, ap_info)

# Keyboard movement handling
ap_sel.key_movement(ap_info)

# Window size adjustment
ap_sel.resize_window(screen, ap_info)

# Template selection interface
template_sel = TuiTemplateSelection()
template_sel.gather_info(template_argument, template_manager)
template_sel.display_phishing_scenarios(screen)

# Get template sections
sections = template_sel.get_sections(template_names, templates)

# Update the section-page mapping
template_sel.update_sec_page_map(last_row)

# Main interface
main_ui = TuiMain()
main_ui.gather_info(screen, info)
main_ui.display_info(screen, info)

# Print HTTP requests
main_ui.print_http_requests(screen, start_row_num, http_output)

# Display a string
from wifiphisher.common.tui import display_string, line_splitter
display_string(w_len, target_line)
line_splitter(num_of_words, line)
```

### Node 13: HTTP Server System (HTTP Server System)

**Function Description**: Provide HTTP server functionality, handling requests and responses for phishing pages, supporting static file services and dynamic content generation.

**Core Algorithms**:
- HTTP request handling.
- Static file service.
- Dynamic content generation.
- Session management.
- Error handling.

**Input/Output Example**:

```python
from wifiphisher.common.phishinghttp import runHTTPServer, BackendHandler, CaptivePortalHandler
from threading import Thread

# Start the HTTP server in a background thread
def start_phishing_server(ip, port, ssl_port, template, extension_manager):
    webserver = Thread(
        target=runHTTPServer,
        args=(ip, port, ssl_port, template, extension_manager))
    webserver.daemon = True
    webserver.start()
    return webserver

# Example usage
ip = "10.0.0.1"
port = 8080
ssl_port = 443
template = "firmware-upgrade"
em = None  # Extension manager instance

webserver = start_phishing_server(ip, port, ssl_port, template, em)
```

### Node 14: Utilities System (Utilities System)

**Function Description**: Provide various utility functions, including command execution, file operations, string processing, and other general-purpose functions.

**Core Algorithms**:
- Command execution and result processing.
- File operations.
- String processing.
- System information acquisition.
- Error handling.

**Input/Output Example**:

```python
from wifiphisher.common.utilities import execute_commands

# Execute system commands
commands = [
    "ifconfig wlan0 up",
    "iwconfig wlan0 mode monitor",
    "ifconfig wlan0 down"
]

results = execute_commands(commands)
for result in results:
    print(f"Command execution result: {result}")

# Other utility functions
from wifiphisher.common.utilities import *

# Get system information
system_info = get_system_info()

# File operations
file_content = read_file_content(file_path)
write_file_content(file_path, content)

# String processing
formatted_string = format_string(template, variables)

# Network tools
is_port_open = check_port_open(host, port)
get_local_ip = get_local_ip_address()
```


### Node 15: Dynamic Channel Range Configuration System (Channel Range System)

**Function Description**: Dynamically configure the WiFi channel range based on geographical location/timezone to comply with regional WiFi regulations.

**Core Algorithms**:
- Timezone detection and analysis
- Regional WiFi regulation compliance  
- Dynamic channel range adjustment
- Global channel state management

**Input/Output Example**:

```python
from wifiphisher.pywifiphisher import set_channel_range
import wifiphisher.common.globals as universal
import time

# Check current timezone
region = time.tzname[time.daylight]
print(f"Current timezone: {region}")

# Set channel range based on timezone
set_channel_range()

# Verify the channel range
if "JST" in region:
    # Japan allows channel 14 (2.4GHz)
    expected_channels = list(range(1, 15))  # [1, 2, ..., 14]
    print("JST timezone detected. Setting channel range to 1-14")
else:
    # Most other regions use channels 1-13
    expected_channels = list(range(1, 14))  # [1, 2, ..., 13]
    print("Non-JST timezone detected. Setting channel range to 1-13")

assert universal.ALL_2G_CHANNELS == expected_channels

# Display active channel range
print(f"Active channel range: {universal.ALL_2G_CHANNELS}")
print(f"Total channels available: {len(universal.ALL_2G_CHANNELS)}")
```

### Node 16: Lure10 Location Spoofing Attack System (Lure10 Attack System)

**Function Description**: Implement the Lure10 attack that exploits Windows Location Service by broadcasting fake beacon frames to make Windows devices believe they are in a previously visited location.

**Core Algorithms**:
- Read BSSID list from capture files
- Generate fake beacon frames with known BSSIDs
- Exploit Windows Location Service vulnerability
- Coordinate with other attack extensions

**Input/Output Example**:

```python
from wifiphisher.extensions.lure10 import Lure10
from collections import namedtuple
import io
import mock

# Test data structure
TestData = namedtuple("test", "args target_ap_channel")
TestArgs = namedtuple("test1", "lure10_exploit")

# Create Lure10 attack with exploit file
args = TestArgs("test_capture_file.txt")
data = TestData(args, 6)
lure10_obj = Lure10(data)

# Simulate BSSID capture file content
bssid0 = "11:11:11:11:11:11"
bssid1 = "22:22:22:22:22:22"
content = io.StringIO(u"{} location1\n{} location2".format(bssid0, bssid1))

# Mock file reading and get attack packets
with mock.patch("wifiphisher.extensions.lure10.open", return_value=content, create=True):
    packets = lure10_obj.get_packet(None)

# Verify beacon frames are generated
result = packets["*"]
assert result[0].subtype == 8  # Beacon frame
assert result[0].addr1 == "ff:ff:ff:ff:ff:ff"  # Broadcast
assert result[0].addr2 == bssid0  # Source BSSID
assert result[0].addr3 == bssid0  # BSSID

# Get attack status output
output = lure10_obj.send_output()
assert "Lure10 - Spoofing location services" in output[0]
```

### Node 17: Handshake Verification System (Handshake Verification System)

**Function Description**: Verify WPA/WPA2 handshake captures using cowpatty to validate captured passwords against handshake files.

**Core Algorithms**:
- Handshake file validation using cowpatty
- Pre-shared key verification
- Command execution and result parsing
- Backend method registration for UI integration

**Input/Output Example**:

```python
from wifiphisher.extensions.handshakeverify import Handshakeverify, is_valid_handshake_capture
from collections import namedtuple
import mock

# Test handshake file validation
handshake_file = "captured_handshake.pcap"
is_valid = is_valid_handshake_capture(handshake_file)
print(f"Handshake file valid: {is_valid}")

# Create handshake verification extension
TestData = namedtuple("test", "args target_ap_essid")
args = mock.Mock()
args.handshake_capture = handshake_file

data = TestData(args, "TestNetwork")
handshake_verify = Handshakeverify(data)

# Test PSK verification (backend method)
psk_candidate = "password123"
verification_result = handshake_verify.psk_verify(psk_candidate)

# Check verification output
output = handshake_verify.send_output()
if handshake_verify.found:
    assert f"VALID KEY: {handshake_verify.key}" in output[0]
else:
    assert f"INVALID KEY ({handshake_verify.key})" in output[0]

# Send channels (empty for this extension)
channels = handshake_verify.send_channels()
assert channels == []
```

### Node 18: UI Method Decorator System (UI Method Decorator System)

**Function Description**: Provide UI method decorators for marking and managing methods related to the user interface.

**Core Algorithms**:
- Method decorators.
- UI method registration.
- Method call management.
- Interface update coordination.

**Input/Output Example**:

```python
from wifiphisher.common.uimethods import uimethod

# Use the UI method decorator
@uimethod
def update_victim_display(self):
    """Update the victim display"""
    victims = self.get_victims()
    self.display_victims(victims)

@uimethod
def update_attack_status(self):
    """Update the attack status"""
    status = self.get_attack_status()
    self.display_status(status)
```
