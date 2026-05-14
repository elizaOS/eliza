import inspect

from tps.configuration.conflicting_app import ConflictingApp
from tps.configuration.binding import Binding
from tps.configuration.feature import Feature


class PersistentDirectory(Feature):
    Id = "PersistentDirectory"
    translatable_name = "Persistent Folder"
    Bindings = (Binding("Persistent", "/home/amnesia/Persistent"),)
    enabled_by_default = True


class BrowserBookmarks(Feature):
    Id = "BrowserBookmarks"
    translatable_name = "Tor Browser Bookmarks"
    Bindings = (Binding("bookmarks", "/home/amnesia/.mozilla/firefox/bookmarks"),)
    conflicting_apps = (
        ConflictingApp(
            name="Tor Browser",
            desktop_id="org.boum.tails.TorBrowser.desktop",
            process_names=["firefox.real"],
        ),
    )


class WelcomeScreen(Feature):
    Id = "WelcomeScreen"
    translatable_name = "Welcome Screen"
    Bindings = (Binding("greeter-settings", "/var/lib/gdm3/settings/persistent"),)


class NetworkConnections(Feature):
    Id = "NetworkConnections"
    translatable_name = "Network Connections"
    Bindings = (
        Binding("nm-system-connections", "/etc/NetworkManager/system-connections"),
    )


class TorConfiguration(Feature):
    Id = "TorConfiguration"
    translatable_name = "Tor Bridge"
    Bindings = (Binding("tca", "/var/lib/tca"),)


class AdditionalSoftware(Feature):
    Id = "AdditionalSoftware"
    translatable_name = "Additional Software"
    Bindings = (
        Binding("apt/cache", "/var/cache/apt/archives"),
        Binding("apt/lists", "/var/lib/apt/lists"),
    )
    enabled_by_default = True
    conflicting_apps = (
        ConflictingApp(name="apt", process_names=["apt"]),
        ConflictingApp(name="apt-get", process_names=["apt-get"]),
        ConflictingApp(name="dpkg", process_names=["dpkg"]),
        ConflictingApp(
            name="Synaptic", desktop_id="synaptic.desktop", process_names=["synaptic"]
        ),
    )


class Printers(Feature):
    Id = "Printers"
    translatable_name = "Printers"
    Bindings = (Binding("cups-configuration", "/etc/cups"),)


class Thunderbird(Feature):
    Id = "Thunderbird"
    translatable_name = "Thunderbird Email Client"
    Bindings = (Binding("thunderbird", "/home/amnesia/.thunderbird"),)
    conflicting_apps = (
        ConflictingApp(
            name="Thunderbird",
            desktop_id="thunderbird.desktop",
            process_names=["thunderbird"],
        ),
    )


class GnuPG(Feature):
    Id = "GnuPG"
    translatable_name = "GnuPG"
    Bindings = (Binding("gnupg", "/home/amnesia/.gnupg"),)
    conflicting_apps = (ConflictingApp(name="gpg", process_names=["gpg"]),)


class Electrum(Feature):
    Id = "Electrum"
    translatable_name = "Electrum Bitcoin Wallet"
    Bindings = (Binding("electrum", "/home/amnesia/.electrum"),)
    conflicting_apps = (
        ConflictingApp(
            name="Electrum", desktop_id="electrum.desktop", process_names=["electrum"]
        ),
    )


class Pidgin(Feature):
    Id = "Pidgin"
    translatable_name = "Pidgin Internet Messenger"
    Bindings = (Binding("pidgin", "/home/amnesia/.purple"),)
    conflicting_apps = (
        ConflictingApp(
            name="Pidgin", desktop_id="pidgin.desktop", process_names=["pidgin"]
        ),
    )


class SSHClient(Feature):
    Id = "SSHClient"
    translatable_name = "SSH Client"
    Bindings = (Binding("openssh-client", "/home/amnesia/.ssh"),)
    conflicting_apps = (ConflictingApp(name="SSH", process_names=["ssh"]),)


class Dotfiles(Feature):
    Id = "Dotfiles"
    translatable_name = "Dotfiles"
    Bindings = (Binding("dotfiles", "/home/amnesia", uses_symlinks=True),)


def get_classes():
    return [
        g for g in globals().values() if inspect.isclass(g) and Feature in g.__bases__
    ]
