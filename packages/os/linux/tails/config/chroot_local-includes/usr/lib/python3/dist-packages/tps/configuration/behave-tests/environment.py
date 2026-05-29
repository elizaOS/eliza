import logging
import os
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import mkdtemp, NamedTemporaryFile
from unittest.mock import Mock

from behave.model import Feature

from behave.model_core import Status

# To be able to run the tests without installing the module first, we
# tell Python where it can find the tps module relative to the script
# directory.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(SCRIPT_DIR, "..", "..", ".."))

from tps import executil  # noqa: E402
from tps.service import Service  # noqa: E402
from tps.configuration.binding import Binding  # noqa: E402

logging.basicConfig(level=logging.DEBUG)

# Create a temporary directory for the nosymfollow bind mount
NOSYMFOLLOW_MOUNTPOINT = mkdtemp(prefix="tails-nosymfollow-")
os.environ["NOSYMFOLLOW_MOUNTPOINT"] = NOSYMFOLLOW_MOUNTPOINT


# This is not actually the class that behave passes to the functions
# below, but pretending that it is provides code completion
class EnvironmentContext:
    # Behave internal
    feature: Feature

    # Added by us
    device_backing_file: str
    device: str
    mount_point: str
    service: Service
    tmpdir: Path
    binding: Binding


def before_feature(context: EnvironmentContext, feature: Feature):
    if "requires_mountpoint" not in feature.tags:
        return

    # Create a file containing an ext4 filesystem and associate it with
    # a loop device, which will be used during the tests as the
    # Persistent Storage cleartext device (/dev/mapper/TailsData_unlocked
    # in a real Tails).

    # We need root privileges to be able to set up a loop device (and
    # also for testing mounting and unmounting).
    if os.geteuid() != 0:
        exit("This test must be run as root")

    # Create a temporary file
    f = NamedTemporaryFile(prefix="dev-TailsData", delete=False)

    # Store the file name for cleanup
    context.device_backing_file = f.name

    # Extend the file to 2MB
    f.truncate(2 * 1024**2)

    # Format it as ext4
    executil.check_call(["mkfs.ext4", f.name])

    # Associate a loop device with it
    context.device = executil.check_output(
        [
            "losetup",
            "--find",
            "--show",
            f.name,
        ]
    ).strip()

    # Mount the loop device
    context.mount_point = mkdtemp(prefix="TailsData-", dir="/var/cache")
    executil.check_call(["mount", context.device, context.mount_point])


def after_feature(context: EnvironmentContext, feature):
    if "requires_mountpoint" not in feature.tags:
        return

    # Clean up the loop device and the associated file.
    # To ensure that as much as possible of the cleanup can be done, we
    # don't exit immediately on an exception, but first continue with
    # the cleanup and raise them in the end.
    exceptions = list()

    # Unmount the device
    try:
        executil.run(["umount", "--force", context.device])
    except Exception as e:
        exceptions.append(e)

    # Remove the mount point
    try:
        os.rmdir(context.mount_point)
    except Exception as e:
        exceptions.append(e)

    # Detach the loop device. We ignore errors and try to continue the
    # cleanup.
    try:
        executil.run(["losetup", "--detach", context.device])
    except Exception as e:
        exceptions.append(e)

    # Remove the temporary file
    try:
        os.remove(context.device_backing_file)
    except Exception as e:
        exceptions.append(e)

    # We can only raise one exception, so we log the rest
    for e in exceptions[1:]:
        logging.exception(e)
    if exceptions:
        raise exceptions[0]


def before_scenario(context: EnvironmentContext, scenario):
    context.binding = None

    if "requires_mock_service" in context.feature.tags:
        context.service = Mock(spec=Service)

    if "requires_mountpoint" in context.feature.tags:
        # Create a temporary directory which is used by the mount tests
        context.tmpdir = Path(mkdtemp(prefix="dest-TailsData", dir="/var/cache"))


def after_scenario(context: EnvironmentContext, scenario):
    if "requires_mountpoint" not in context.feature.tags:
        return

    # Deactivate the binding in case it was activated by the scenario
    # (deactivate() doesn't fail it was not)
    if context.binding:
        context.binding.deactivate()

    # Clean up any content that the scenario might have created on the
    # mount point
    for p in Path(context.mount_point).iterdir():
        if p.is_dir():
            shutil.rmtree(p)
        else:
            p.unlink()

    # Also clean up any content of the mount point below the nosymfollow
    # mount point
    for p in Path(NOSYMFOLLOW_MOUNTPOINT + str(context.mount_point)).iterdir():
        # We don't use shutil.rmtree here because apparently it tries
        # to follow symlinks, which will fail below the nosymfollow
        # mountpoint
        subprocess.run(["/bin/rm", "-rf", str(p)], check=True)

    # Remove the destination directory
    shutil.rmtree(context.tmpdir)


def before_tag(context, tag):
    if tag == "symlink_attack":
        os.environ["SYMLINK_ATTACK_TEST"] = "1"


def after_tag(context, tag):
    os.unsetenv("SYMLINK_ATTACK_TEST")


###############################################
# Enable Debug-on-Error support as described in
# https://behave.readthedocs.io/en/stable/tutorial.html#debug-on-error-in-case-of-step-failures
###############################################

BEHAVE_DEBUG_ON_ERROR = False


def setup_debug_on_error(userdata):
    global BEHAVE_DEBUG_ON_ERROR  # noqa: PLW0603
    BEHAVE_DEBUG_ON_ERROR = userdata.getbool("BEHAVE_DEBUG_ON_ERROR")


def before_all(context):
    setup_debug_on_error(context.config.userdata)

    # Create a bind-mount of the root filesystem with the nosymfollow
    # option set. In production, the same is done by
    # config/chroot_local-includes/lib/systemd/system/run-nosymfollow.mount.
    # We also do it here to test that it does prevent symlink attacks.
    Path(NOSYMFOLLOW_MOUNTPOINT).mkdir(exist_ok=True)
    subprocess.run(
        ["/bin/mount", "--bind", "/", "-o", "bind,nosymfollow", NOSYMFOLLOW_MOUNTPOINT],
        check=True,
    )


def after_all(context):
    subprocess.run(["/bin/umount", NOSYMFOLLOW_MOUNTPOINT], check=True)
    os.rmdir(NOSYMFOLLOW_MOUNTPOINT)


def after_step(context, step):
    if BEHAVE_DEBUG_ON_ERROR and step.status == Status.failed:
        # -- ENTER DEBUGGER: Zoom in on failure location.
        # NOTE: Use IPython debugger, same for pdb (basic python debugger).
        import ipdb  # noqa: T100

        ipdb.post_mortem(step.exc_traceback)
