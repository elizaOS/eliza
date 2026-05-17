import os
from typing import Any, ClassVar
from collections.abc import Callable
import socket
from logging import getLogger
import time

import gi
from tails_jsonrpc import Protocol, InvalidMessageError

gi.require_version("GLib", "2.0")

from gi.repository import GObject  # noqa: E402
from gi.repository import GLib  # noqa: E402

log = getLogger("asyncutils")

AsyncCallback = Callable[[GObject.GObject, dict | None, str | None, dict | None], Any]


class GJsonRpcClient(GObject.GObject):
    """
    Wrap a raw socket and uses JSON-RPC over it.

    Supports calling methods, but not receiving server-initiated messages (ie: signals)
    """

    __gsignals__: ClassVar[dict] = {
        "connection-closed": (
            GObject.SignalFlags.RUN_LAST,
            GObject.TYPE_NONE,
            (),
        ),
        "response": (
            GObject.SignalFlags.RUN_LAST | GObject.SignalFlags.DETAILED,
            GObject.TYPE_NONE,
            [GObject.TYPE_PYOBJECT, GObject.TYPE_STRING, GObject.TYPE_PYOBJECT],
        ),
        "response-error": (
            GObject.SignalFlags.RUN_LAST | GObject.SignalFlags.DETAILED,
            GObject.TYPE_NONE,
            [GObject.TYPE_STRING, GObject.TYPE_PYOBJECT],
        ),
        "response-success": (
            GObject.SignalFlags.RUN_LAST | GObject.SignalFlags.DETAILED,
            GObject.TYPE_NONE,
            [GObject.TYPE_PYOBJECT, GObject.TYPE_PYOBJECT],
        ),
    }

    MAX_LINESIZE = 1024

    def __init__(self, sock: socket.socket):
        GObject.GObject.__init__(self)
        self.protocol = Protocol()
        self.sock = sock
        self.buffer = b""

    def run(self):
        GLib.io_add_watch(self.sock.fileno(), GLib.IO_IN, self._on_data)
        GLib.io_add_watch(self.sock.fileno(), GLib.IO_HUP | GLib.IO_ERR, self._on_close)

    def call_async(self, method: str, callback: AsyncCallback | None, *args):
        req = self.protocol.create_request(method, args)
        log.debug("call async %s %s %d", method, args, req.unique_id)
        if callback is not None:
            self.connect("response::%d" % req.unique_id, callback)
        output = req.serialize() + "\n"
        self.sock.send(output.encode("utf8"))
        return req

    def _on_close(self, *args):
        self.emit("connection-closed")

    def _on_data(self, *args):
        self.buffer += self.sock.recv(self.MAX_LINESIZE)
        while b"\n" in self.buffer:
            newline_pos = self.buffer.find(b"\n")
            msg = self.buffer[:newline_pos]
            self.buffer = self.buffer[newline_pos + 1 :]
            try:
                response = self.protocol.parse_reply(msg)
            except InvalidMessageError:
                return None
            if hasattr(response, "error"):
                errordata = {}
                errordata["code"] = response.code
                errordata["data"] = response.data
                self.emit(
                    "response-error::%d" % response.unique_id, response.error, errordata
                )
                self.emit(
                    "response::%d" % response.unique_id, None, response.error, errordata
                )
            else:
                self.emit(
                    "response-success::%d" % response.unique_id, response.result, None
                )
                self.emit(
                    "response::%d" % response.unique_id, response.result, None, None
                )
        return True


class GAsyncSpawn(GObject.GObject):
    """GObject class to wrap GLib.spawn_async().

    Use:
        s = GAsyncSpawn()
        s.connect('process-done', mycallback)
        s.run(command)
            #command: list of strings
    """

    __gsignals__: ClassVar[dict] = {
        "process-done": (
            GObject.SignalFlags.RUN_LAST,
            GObject.TYPE_NONE,
            (GObject.TYPE_INT,),
        ),
        "stdout-data": (
            GObject.SignalFlags.RUN_LAST,
            GObject.TYPE_NONE,
            (GObject.TYPE_STRING,),
        ),
        "stderr-data": (
            GObject.SignalFlags.RUN_LAST,
            GObject.TYPE_NONE,
            (GObject.TYPE_STRING,),
        ),
    }

    def __init__(self):
        GObject.GObject.__init__(self)

    def run(self, cmd):
        r = GLib.spawn_async(
            cmd,
            flags=GLib.SPAWN_DO_NOT_REAP_CHILD,
            standard_output=True,
            standard_error=True,
        )
        self.pid, idin, idout, iderr = r
        fout = os.fdopen(idout, "r")
        ferr = os.fdopen(iderr, "r")

        self.event_sources = []

        self.event_sources.append(GLib.child_watch_add(self.pid, self._on_done))
        self.event_sources.append(GLib.io_add_watch(fout, GLib.IO_IN, self._on_stdout))
        self.event_sources.append(GLib.io_add_watch(ferr, GLib.IO_IN, self._on_stderr))
        return self.pid

    def _on_done(self, pid, retval, *argv):
        self.emit("process-done", retval)
        for evt in self.event_sources:
            GLib.source_remove(evt)

    def _emit_std(self, name, value):
        self.emit(name + "-data", value)

    def _on_stdout(self, fobj, cond):
        self._emit_std("stdout", fobj.readline())
        return True

    def _on_stderr(self, fobj, cond):
        self._emit_std("stderr", fobj.readline())
        return True


def idle_add_chain(functions: list[Callable]):
    """
    Wrap GLib.idle_add allowing chains of functions.

    Use case: idle_add is very cool, but modifications to widgets aren't applied
    until the whole method add.
    A simple solution to this shortcoming is split your function in many small ones,
    and call them in a chain.

    Using idle_add_chain, you can write each step as a separate function,
    then call idle_add_chain with a list
    of those functions. The chain will continue ONLY if you return True.
    """
    if not functions:
        return
    first = functions.pop(0)

    def wrapped_fn():
        ret = first()
        if ret is True and functions:
            idle_add_chain(functions)

    GLib.idle_add(wrapped_fn)


class ExternalProperty(GObject.Object):
    """
    This class (and its subclasses) provides a way to encapsulate complex properties that we need to track
    about the other world.

    Every property is a new class, which should subclass this one.

    In most cases, you just need to define the `check` method.

    Polling is built-in feature; subscribing to events is still possible, you just need to arrange it either
    in a subclass (see NetworkLink) or externally (see DisableNetwork)
    """

    __gsignals__: ClassVar[dict] = {
        "changed": (
            GObject.SignalFlags.RUN_LAST,
            GObject.TYPE_NONE,
            (),
        ),
    }

    def __init__(self):
        GObject.GObject.__init__(self)
        self.value = None
        self.last_change = None
        self.log = getLogger(self.__class__.__name__)

    def register_polling(self, interval_seconds: int):
        GLib.timeout_add_seconds(interval_seconds, self.tick)

    def tick(self) -> bool:
        """wrapper over self.check which makes sure polling is re-run, by returning True"""
        self.check()
        return True

    def on_value_received(self, new_value):
        if self.last_change is None or new_value != self.value:
            self.log.info("Changed from %s to %s", self.value, new_value)
            self.value = new_value
            self.last_change = time.time()
            self.emit("changed")

    def check(self):
        # this is the only method subclasses MUST implement
        # the return value is discarded:
        # to actually submit a new value, call on_value_received
        raise NotImplementedError


class ExternalPropertyCommand(ExternalProperty):
    """
    This class provides everything you need when you want to run a process and only need its status code.

    This class makes it extremely easy to monitor such a process: just subclass and define COMMAND.
    """

    def normalize_retval(self, retval: int):
        return retval

    def check(self):
        def on_received(spawn, retval):
            self.on_value_received(self.normalize_retval(retval))

        test = GAsyncSpawn()
        test.connect("process-done", on_received)
        test.run(self.COMMAND)


class ExternalPropertyCommandBool(ExternalPropertyCommand):
    """
    It's very common that commands have exit code zero on success, nonzero on failure.

    This class makes it extremely easy to monitor such a process: just subclass and define COMMAND.
    """

    def normalize_retval(self, retval: int) -> bool:
        return retval == 0
