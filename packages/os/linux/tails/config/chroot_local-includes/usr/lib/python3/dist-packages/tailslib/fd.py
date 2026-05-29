""" Functions to open sockets and files and make them inheritable.

This is useful when you want to open a socket or file with higher
privileges and then drop privileges and pass the file descriptor to
another process."""

from pathlib import Path
import logging
import os
import socket
from typing import Any, Union

from gi.repository import Gio

# We add all open sockets / file descriptors to this list to avoid them
# being garbage collected.
objects: list[Any] = []


def connect_socket(family: socket.AddressFamily, address: str) -> int:
    s = socket.socket(family=family, type=socket.SOCK_STREAM)
    objects.append(s)
    fd = s.fileno()
    s.connect(address)
    os.set_inheritable(fd, True)
    logging.debug("fd=%d [%s]", fd, address)
    return fd


def open_file(path: Union[str, Path], mode: int) -> int:
    fd = os.open(path, mode)
    objects.append(fd)
    os.set_inheritable(fd, True)
    logging.debug("fd=%d [%s]", fd, path)
    return fd


def connect_dbus_system_bus() -> int:
    # We get the address of the D-Bus system bus the same way
    # systemd and Gio.dbus_address_get_for_bus do, which is to
    # use the value of the DBUS_SYSTEM_BUS_ADDRESS env var if it's
    # set, else unix:path=/var/run/dbus/system_bus_socket.
    address = os.getenv("DBUS_SYSTEM_BUS_ADDRESS")
    if not address:
        address = "unix:path=/var/run/dbus/system_bus_socket"
    if not address.startswith("unix:path="):
        raise RuntimeError("Unexpected D-Bus path %s" % address)
    address = address.removeprefix("unix:path=")
    logging.debug("D-Bus address: %s", address)
    fd = connect_socket(socket.AF_UNIX, address)

    logging.debug("Authenticating to D-Bus")
    s = Gio.Socket.new_from_fd(fd=fd)
    socket_connection = s.connection_factory_create_connection()
    dbus = Gio.DBusConnection.new_sync(
        socket_connection,
        None,
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT,
        None,
        None,
    )  # type: Gio.DBusConnection
    objects.append(dbus)

    return fd
