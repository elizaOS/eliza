import abc
import logging
from gi.repository import GLib
import os
from pathlib import Path
import psutil
import time
from typing import TYPE_CHECKING, Optional

import tps.logging
from tps import executil
from tps import (
    State,
    DBUS_FEATURE_INTERFACE,
    DBUS_FEATURES_PATH,
    ON_ACTIVATED_HOOKS_DIR,
    ON_DEACTIVATED_HOOKS_DIR,
)
from tps.configuration.binding import Binding, IsActiveException, IsInactiveException
from tps.dbus.errors import (
    ActivationFailedError,
    DeletionFailedError,
    JobCancelledError,
    FailedPreconditionError,
    DeactivationFailedError,
)
from tps.dbus.object import DBusObject
from tps.job import ServiceUsingJobs

if TYPE_CHECKING:
    from tps.configuration.conflicting_app import ConflictingApp
    from tps.service import Service

logger = tps.logging.get_logger(__name__)


class ConflictingProcessesError(Exception):
    pass


class Feature(DBusObject, ServiceUsingJobs, metaclass=abc.ABCMeta):
    dbus_info = """
    <node>
        <interface name='org.boum.tails.PersistentStorage.Feature'>
            <method name='Activate'/>
            <method name='Deactivate'/>
            <method name='Delete'/>
            <property name="Id" type="s" access="read"/>
            <property name="Description" type="s" access="read"/>
            <property name="IsActive" type="b" access="read"/>
            <property name="IsEnabled" type="b" access="read"/>
            <property name="HasData" type="b" access="read"/>
            <property name="Job" type="o" access="read"/>
        </interface>
    </node>
    """

    @property
    def dbus_path(self):
        return os.path.join(DBUS_FEATURES_PATH, self.Id)

    def __init__(self, service: "Service", is_custom: bool = False):
        logger.debug("Initializing feature %r", self.Id)
        super().__init__(connection=service.connection)
        self.service = service
        self.is_custom = is_custom

        # Check if the feature is enabled in the config file
        config_file = self.service.config_file
        self._is_enabled = config_file.exists() and config_file.contains(self)
        self._last_signaled_is_enabled = self._is_enabled
        self._is_active = all(binding.is_active() for binding in self.Bindings)
        self._last_signaled_is_active = self._is_active
        self._has_data = any(binding.has_data() for binding in self.Bindings)
        self._last_signaled_has_data = self._has_data

    # ----- Exported functions ----- #

    def Activate(self):
        # Check if we can activate the feature
        if self.service.state != State.UNLOCKED:
            msg = "Can't activate features when state is '%s'" % self.service.state.name
            raise FailedPreconditionError(msg)

        # If there is still a job running, cancel it
        if self._job:
            self._job.Cancel()

        # Create a job for the activation. We do this to allow the user
        # to cancel the job. During activation / deactivation, we wait
        # until all conflicting processes were terminated. Sometimes it
        # might not be possible / desirable for the user to terminate
        # conflicting processes, so we want to support cancellation.
        #
        # The simpler alternative would be to raise an error if any
        # conflicting processes are running and let the user
        # re-trigger the activation / deactivation once they
        # terminated the conflicting processes. But that would provide
        # worse UX, because a conflicting process might take quite
        # some time to terminate after the user closed the
        # corresponding application window. They would have to keep
        # re-triggering the activation / deactivation until the process
        # terminated.
        try:
            with self.new_job() as job:
                self.do_activate(job)
        finally:
            self.refresh_state(emit_properties_changed_signal=True)

    def do_activate(self, job: Optional["Job"], non_blocking=False):
        logger.info(f"Activating feature {self.Id}")

        apps = self.get_running_conflicting_apps()
        if apps and non_blocking:
            # Note that we don't translate this error message because
            # it's not meant to be passed to the user, but only logged
            # for debugging purposes.
            raise ConflictingProcessesError(
                f"Can't activate feature {self.Id}: Conflicting "
                f"applications are running ({' '.join(apps)})"
            )
        elif apps:
            # Wait for conflicting processes to terminate. If the job is
            # cancelled by the user before the conflicting processes
            # terminate, an exception will be thrown, which will be passed
            # on to the client and handled there.
            self.wait_for_conflicting_processes_to_terminate(job)

        for binding in self.Bindings:
            binding.activate()

        # Check if the bindings were actually activated
        try:
            for binding in self.Bindings:
                binding.check_is_active()
        except IsInactiveException as e:
            msg = f"Activation of feature '{self.Id}' failed unexpectedly"
            raise ActivationFailedError(msg) from e

        self.run_on_activated_hooks()
        self.service.enable_feature(self)

    def Deactivate(self):
        # Check if we can deactivate the feature
        if self.service.state != State.UNLOCKED:
            msg = (
                "Can't deactivate features when state is '%s'" % self.service.state.name
            )
            raise FailedPreconditionError(msg)

        # If there is still a job running, cancel it
        if self._job:
            self._job.Cancel()

        # Create a job for the deactivation. For rationale on why we
        # use a job here, see the comment in Activate().
        try:
            with self.new_job() as job:
                self.do_deactivate(job)
        finally:
            self.refresh_state(emit_properties_changed_signal=True)

    def do_deactivate(self, job: Optional["Job"]):
        logger.info(f"Deactivating feature {self.Id}")

        # Wait for conflicting processes to terminate. If the job is
        # cancelled by the user before the conflicting processes
        # terminate, an exception will be thrown, which will be passed
        # on to the client and handled there.
        self.wait_for_conflicting_processes_to_terminate(job)

        for binding in self.Bindings:
            binding.deactivate()

        # Check if the bindings were actually deactivated
        try:
            for binding in self.Bindings:
                binding.check_is_inactive()
        except IsActiveException as e:
            msg = f"Deactivation of feature '{self.Id}' failed unexpectedly"
            raise DeactivationFailedError(msg) from e

        self.run_on_deactivated_hooks()
        self.service.disable_feature(self)

    def Delete(self):
        try:
            self.do_delete()
        finally:
            self.refresh_state()
            self.signal_properties_changed()

    def do_delete(self):
        # Check if we can delete the feature
        if self.service.state != State.UNLOCKED:
            msg = "Can't delete features when state is '%s'" % self.service.state.name
            raise FailedPreconditionError(msg)

        # Check if feature is active
        self.refresh_state(["IsActive"])
        if self.IsActive:
            msg = f"Can't delete active feature '{self.Id}'"
            raise FailedPreconditionError(msg)

        logger.info(f"Deleting feature {self.Id}")

        for binding in self.Bindings:
            executil.check_call(["rm", "-rf", binding.src])

        self.refresh_state(["HasData"])
        if self.HasData:
            msg = f"Deletion command successful but feature '{self.Id}' still has data"
            raise DeletionFailedError(msg)

    # ----- Exported properties ----- #

    @property
    def IsActive(self) -> bool:
        return self._is_active

    @property
    def IsEnabled(self) -> bool:
        return self._is_enabled

    @property
    def HasData(self) -> bool:
        return self._has_data

    @property
    def Job(self) -> str:
        return self._job.dbus_path if self._job else "/"

    @Job.setter
    def Job(self, job: "Job"):
        self._job = job
        changed_properties = {"Job": GLib.Variant("s", self.Job)}
        self.emit_properties_changed_signal(
            self.service.connection, DBUS_FEATURE_INTERFACE, changed_properties
        )

    @property
    @abc.abstractmethod
    def Id(self) -> str:
        """The name of the feature for internal usage and in logs. It
        must only contain the ASCII characters "[A-Z][a-z][0-9]_"."""
        return ""

    @property
    def Description(self) -> str:
        """The name of the feature that will be shown to the user.
        Only used for custom features for now."""
        return ""

    @property
    @abc.abstractmethod
    def Bindings(self) -> list[Binding]:
        """A list of bindings, which are mappings of source directories
        to target paths. The source directories will be mounted or
        symlinked to the target paths when the feature is activated."""
        return list()

    # ----- Non-exported properties ------ #

    @property
    @abc.abstractmethod
    def translatable_name(self) -> str:
        """The name of the feature for usage in user-visible strings"""
        return ""

    @property
    def conflicting_apps(self) -> list["ConflictingApp"]:
        """A list of applications which must not be currently running
        when the feature is activated/deactivated."""
        return list()

    @property
    def enabled_by_default(self) -> bool:
        """Whether this feature should be enabled by default"""
        return False

    # ----- Non-exported functions ----- #

    def run_on_activated_hooks(self):
        hooks_dir = Path(ON_ACTIVATED_HOOKS_DIR, self.Id)
        executil.execute_hooks(hooks_dir)

    def run_on_deactivated_hooks(self):
        hooks_dir = Path(ON_DEACTIVATED_HOOKS_DIR, self.Id)
        executil.execute_hooks(hooks_dir)

    def refresh_state(
        self,
        properties: Optional[list[str]] = None,
        emit_properties_changed_signal=False,
    ):
        if not properties:
            properties = ["IsEnabled", "HasData", "IsActive"]

        exceptions = list()

        if "IsEnabled" in properties:
            try:
                config_file = self.service.config_file
                self._is_enabled = config_file.exists() and config_file.contains(self)
            except Exception as e:
                if exceptions:
                    logging.exception(e)
                exceptions.append(e)

        if "HasData" in properties:
            try:
                self._has_data = any(binding.has_data() for binding in self.Bindings)
            except Exception as e:
                if exceptions:
                    logging.exception(e)
                exceptions.append(e)
                # Figuring out if there is data or not failed. We set
                # HasData to True in this case because then we display
                # a "Delete Data" button in the frontend which the user
                # could use to try and fix the issue (if they don't care
                # about the data).
                self._has_data = True

        if "IsActive" in properties:
            try:
                self._is_active = all(binding.is_active() for binding in self.Bindings)
            except Exception as e:
                if exceptions:
                    logging.exception(e)
                exceptions.append(e)

        if emit_properties_changed_signal:
            self.signal_properties_changed()

        if exceptions:
            raise exceptions[0]

    def signal_properties_changed(self):
        changed_properties = dict()

        if self._is_enabled != self._last_signaled_is_enabled:
            changed_properties["IsEnabled"] = GLib.Variant("b", self._is_enabled)
            self._last_signaled_is_enabled = self._is_enabled

        if self._has_data != self._last_signaled_has_data:
            changed_properties["HasData"] = GLib.Variant("b", self._has_data)
            self._last_signaled_has_data = self._has_data

        if self._is_active != self._last_signaled_is_active:
            changed_properties["IsActive"] = GLib.Variant("b", self._is_active)
            self._last_signaled_is_active = self._is_active

        if changed_properties:
            self.emit_properties_changed_signal(
                self.service.connection, DBUS_FEATURE_INTERFACE, changed_properties
            )

    def wait_for_conflicting_processes_to_terminate(self, job: "Job"):
        """Waits until all conflicting processes were terminated.
        Raises a JobCancelledError if the job was cancelled while
        waiting."""

        # We tried to automatically find processes which use any of the
        # destination directories via lsof. We encountered some issues
        # with that:
        #  * lsof without any options can take a long time if there are
        #    a lot of active processes with a lot of open files.
        #  * lsof +D calls stat on each file in the directory, which
        #    can also take a long time if the directory is large.
        #  * lsof +D furthermore exits with exit code 1 if any of the
        #    files in the directory do *not* have any file use, which
        #    makes it hard to distinguish this (expected) case from
        #    actual error cases.
        #  * lsof +f with a mounted-on directory of a file system does
        #    not seem to list all files open on the file system.
        #    For example, this does not list the vim swap file:
        #       # vim /test
        #       # lsof +f -- / | grep test
        #    ... while this does:
        #       # vim /test
        #       # lsof -x +d / | grep test
        #
        # In the end, we decided to not automatically check for
        # processes using the destination directories, but only check
        # for those processes which should definitely not be running.

        apps = self.get_running_conflicting_apps()

        # Set the conflicting processes, so that the frontend can tell
        # the user to close the corresponding applications
        job.ConflictingApps = apps

        if not job.ConflictingApps:
            # There are no conflicting processes, so we don't have
            # to wait for anything
            return

        logger.info("Waiting for the user to terminate processes %s", apps)
        while any(job.ConflictingApps.values()):
            if job.cancellable.is_cancelled():
                logger.info("Job was cancelled")
                # We raise an exception here to handle the case that the
                # job was cancelled unexpectedly. We expect the client
                # to cancel the cancellable of the GDBus method call
                # *before* cancelling the job, so in that case they
                # won't receive the error anyway.
                raise JobCancelledError()

            # Check if processes were terminated
            for app in job.ConflictingApps:
                for pid in job.ConflictingApps[app]:
                    if not psutil.pid_exists(pid):
                        logger.info(f"Conflicting process {pid} was terminated")
                        job.ConflictingApps[app].remove(pid)

            time.sleep(0.2)

        logger.info("All conflicting processes were terminated, continuing")
        return

    def get_running_conflicting_apps(self) -> dict[str, list[int]]:
        res = dict()
        for app in self.conflicting_apps:
            # Get the list of currently running processes which belong
            # to the app
            processes = app.get_processes()
            if not processes:
                continue
            name = app.try_get_translated_name()
            pids = [p.pid for p in processes]
            res[name] = pids
        return res
