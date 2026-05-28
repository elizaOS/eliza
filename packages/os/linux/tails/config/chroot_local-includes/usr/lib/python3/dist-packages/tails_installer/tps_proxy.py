import os

from gi.repository import Gio

TPS_DBUS_SERVICE_NAME = "org.boum.tails.PersistentStorage"
TPS_DBUS_ROOT_OBJECT_PATH = "/org/boum/tails/PersistentStorage"
TPS_DBUS_SERVICE_INTERFACE = "org.boum.tails.PersistentStorage"


def _get_proxy() -> Gio.DBusProxy:
    # Connect to D-Bus via the open file descriptor which we inherited
    # from inherit-fd and which is connected to the system bus and
    # already authenticated as user tails-persistent-storage.
    authenticated_dbus_fd = 3
    socket = Gio.Socket.new_from_fd(fd=int(authenticated_dbus_fd))
    socket_connection = socket.connection_factory_create_connection()
    bus: Gio.DBusConnection = Gio.DBusConnection.new_sync(
        socket_connection,
        None,
        Gio.DBusConnectionFlags.NONE | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
        None,
        None,
    )

    return Gio.DBusProxy.new_sync(
        bus,
        Gio.DBusProxyFlags.NONE,
        None,
        TPS_DBUS_SERVICE_NAME,
        TPS_DBUS_ROOT_OBJECT_PATH,
        TPS_DBUS_SERVICE_INTERFACE,
        None,
    )


tps_proxy = _get_proxy()
