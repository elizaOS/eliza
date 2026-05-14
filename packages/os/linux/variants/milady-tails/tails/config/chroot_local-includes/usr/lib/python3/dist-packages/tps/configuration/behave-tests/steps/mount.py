import errno  # noqa: F401
import shutil
from behave import given, when, then
from pathlib import Path
import os
import sys
from tempfile import mkdtemp

# To be able to run the tests without installing the module first, we
# tell Python where it can find the tps module relative to the script
# directory.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(SCRIPT_DIR, "..", "..", "..", ".."))

from tps.configuration.binding import Binding  # noqa: F401
from tps.mountutil import MountException  # noqa: F401

# Import testutils
sys.path.insert(0, SCRIPT_DIR)
import testutils


# A definition of the context we pass between step implementations.
# This is not actually the class that behave passes to the step_impl
# functions, but pretending that it is provides code completion.
class TestContext(object):
    binding: Binding
    binding_exception: Exception
    # These are set in environment.py before* functions
    tmpdir: Path
    mount_point: str


TEST_FILE_NAME = "testfile"
SECRET_FILE_NAME = "shadow"
SECRET_CONTENT = "secret"
SECRET_DIR_NAME = "secrets"


@given(
    'a binding object for mounting a directory "{src}" to '
    '"{dest}" in the destination directory'
)
def step_impl(context: TestContext, src: str, dest: str):
    context.binding = Binding(
        src, os.path.join(context.tmpdir, dest), tps_mount_point=context.mount_point
    )


@given(
    'a binding object for symlinking a directory "{src}" to '
    '"{dest}" in the destination directory'
)
def step_impl(context: TestContext, src: str, dest: str):
    context.binding = Binding(
        src,
        os.path.join(context.tmpdir, dest),
        tps_mount_point=context.mount_point,
        uses_symlinks=True,
    )


@given("the {binding_operand} directory exists")
def step_impl(context: TestContext, binding_operand: str):
    path = testutils.get_binding_operand(context.binding, binding_operand)
    # Create the directory
    path.mkdir(mode=0o770)


@given("the {binding_operand} directory is owned by {user}")
def step_impl(context: TestContext, binding_operand: str, user: str):
    path = testutils.get_binding_operand(context.binding, binding_operand)
    # Create the directory
    os.chown(path, testutils.get_uid(user), -1)


@given("the {binding_operand} directory contains a file owned by {user}")
def step_impl(context: TestContext, binding_operand: str, user: str):
    path = testutils.get_binding_operand(context.binding, binding_operand)
    # Create the test file
    f = Path(path, TEST_FILE_NAME)
    f.touch(mode=600)
    os.chown(f, testutils.get_uid(user), -1)


@given("the {binding_operand} directory contains a valid symlink")
def step_impl(context: TestContext, binding_operand: str):
    path = testutils.get_binding_operand(context.binding, binding_operand)
    # Create the test file
    f = Path(path, TEST_FILE_NAME)
    f.touch(mode=600)
    symlink = Path(path, "symlink")
    symlink.symlink_to(f)


@given("the source directory contains a broken symlink")
def step_impl(context: TestContext):
    symlink = Path(context.binding.src, "symlink")
    symlink.symlink_to("/non-existent")


@given("the path of the destination directory is below /home/amnesia")
def step_impl(context: TestContext):
    # Remove the tmpdir created by environment.py
    shutil.rmtree(context.tmpdir)
    # Create a new tmpdir (this will be cleaned up by after_scenario()
    # in environment.py
    home = Path(context.binding.nosymfollow_mountpoint, "home/amnesia")
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    context.tmpdir = Path(mkdtemp(prefix="dest-TailsData", dir=home))
    context.binding.dest = Path(context.tmpdir, os.path.basename(context.binding.dest))


@given("the destination is a symlink")
def step_impl(context: TestContext):
    context.binding.dest.symlink_to(context.tmpdir)


@given("the destination is a symlink to an empty directory owned by root")
def step_impl(context: TestContext):
    d = Path(context.tmpdir, SECRET_DIR_NAME)
    d.mkdir(mode=600)
    context.binding.dest.symlink_to(d)


@given("the destination is a broken symlink")
def step_impl(context: TestContext):
    context.binding.dest.symlink_to(Path(context.tmpdir, "nonexistent"))


@given("the path to the destination directory contains a symlink")
def step_impl(context: TestContext):
    # Create the destination directory as a symlink
    context.binding.dest.symlink_to(context.tmpdir)
    # Change the destination to a file below the old destination
    context.binding.dest = Path(context.binding.dest, "foo")


@given("the path to the destination directory contains a broken symlink")
def step_impl(context: TestContext):
    # Create the destination directory as a symlink
    context.binding.dest.symlink_to(Path(context.tmpdir, "nonexistent"))
    # Change the destination to a file below the old destination
    context.binding.dest = Path(context.binding.dest, "foo")


@given("the destination directory exists and its path contains a symlink")
def step_impl(context: TestContext):
    # Create the destination directory as a symlink
    context.binding.dest.symlink_to(context.tmpdir)
    # Change the destination to a file below the old destination
    context.binding.dest = Path(context.binding.dest, "foo")
    # Create the file below the symlink target
    Path(context.tmpdir, "foo").touch()


@given(
    "the destination directory contains a file of the same name, which is a symlink to a file owned by {user}"
)
def step_impl(context: TestContext, user: str):
    f = Path(context.tmpdir, SECRET_FILE_NAME)
    f.touch(mode=600)
    f.write_text(SECRET_CONTENT)
    os.chown(f, testutils.get_uid(user), -1)
    s = Path(context.binding.dest, TEST_FILE_NAME)
    s.symlink_to(f)


@when("the binding is activated")
def step_impl(context: TestContext):
    # Activate the binding
    context.binding.activate()
    # Check that the binding was activated
    context.binding.check_is_active()


@when("the binding is tried to be activated")
def step_impl(context: TestContext):
    # Try to activate the binding
    try:
        context.binding.activate()
    except Exception as e:
        context.binding_exception = e
    else:
        # Check that the mount was activated
        context.binding.check_is_active()


@then("the {binding_operand} directory is empty")
def step_impl(context: TestContext, binding_operand: str):
    path = testutils.get_binding_operand(context.binding, binding_operand)
    # Check that the directory is empty
    assert not any(path.iterdir())


@then("the {binding_operand} directory exists")
def step_impl(context: TestContext, binding_operand: str):
    path = testutils.get_binding_operand(context.binding, binding_operand)
    # Check that the directory exists
    assert path.is_dir()


@then("the {binding_operand} directory does not exist")
def step_impl(context: TestContext, binding_operand: str):
    path = testutils.get_binding_operand(context.binding, binding_operand)
    # Check that the path does not exist
    assert not path.exists()


@then("the {binding_operand} directory is owned by {user}")
def step_impl(context: TestContext, binding_operand: str, user: str):
    path = testutils.get_binding_operand(context.binding, binding_operand)
    # Check that the directory is owned by {user}
    assert path.stat().st_uid == testutils.get_uid(user)


@then(
    "the source and destination directories have the same owner and permissions recursively"
)
def step_impl(context: TestContext):
    testutils.check_same_permissions_and_owner_recursively(
        context.binding.src,
        context.binding.dest,
    )


@then("the {binding_operand} directory contains a file owned by {user}")
def step_impl(context: TestContext, binding_operand: str, user: str):
    path = testutils.get_binding_operand(context.binding, binding_operand)
    # Check that the test file exists
    f = Path(path, TEST_FILE_NAME)
    assert f.is_file()
    # Check that the test file is owned by {user}
    assert f.lstat().st_uid == testutils.get_uid(user)


@then("the {binding_operand} directory contains a symlink to a file owned by {user}")
def step_impl(context: TestContext, binding_operand: str, user: str):
    path = testutils.get_binding_operand(context.binding, binding_operand)
    # Check that the test file exists
    f = Path(path, TEST_FILE_NAME).readlink()
    assert f.is_file()
    # Check that the test file is owned by {user}
    assert f.lstat().st_uid == testutils.get_uid(user)


@then("the {binding_operand} directory contains a symlink to a valid symlink")
def step_impl(context: TestContext, binding_operand: str):
    path = testutils.get_binding_operand(context.binding, binding_operand)
    # Check that the symlink points to another symlink
    symlink = Path(path, "symlink").readlink()
    assert symlink.is_symlink()
    assert symlink.resolve().exists()


@then("the {binding_operand} directory contains a symlink to a broken symlink")
def step_impl(context: TestContext, binding_operand: str):
    path = testutils.get_binding_operand(context.binding, binding_operand)
    # Check that the symlink points to another symlink
    symlink = Path(path, "symlink").readlink()
    assert symlink.is_symlink()
    assert not symlink.readlink().exists()


@then("binding activation fails with OSError {errno_name}")
def step_impl(context: TestContext, errno_name: str):
    assert isinstance(context.binding_exception, OSError)
    assert context.binding_exception.errno == eval(  # nosec blacklist
        f"errno.{errno_name}"
    )
    # Unset the exception so that it doesn't affect other scenarios
    context.binding_exception = None


@then("binding activation fails with a {exception}")
def step_impl(context: TestContext, exception: str):
    assert isinstance(context.binding_exception, eval(exception))  # nosec blacklist
    # Unset the exception so that it doesn't affect other scenarios
    context.binding_exception = None


@then(
    "the destination directory contains symlinks to all the files in the source directory"
)
def step_impl(context: TestContext):
    # The _check_is_active_using_symlinks function checks exactly what we want
    # to check here
    context.binding._check_is_active_using_symlinks()


@then("the {binding_operand} directory contains no symlink")
def step_impl(context: TestContext, binding_operand: str):
    path = testutils.get_binding_operand(context.binding, binding_operand)
    for child in path.iterdir():
        assert not child.is_symlink()


@then("the file owned by root was not changed")
def step_impl(context: TestContext):
    f = Path(context.tmpdir, SECRET_FILE_NAME)
    assert f.exists()
    assert not f.is_symlink()
    assert f.read_text() == SECRET_CONTENT
    assert f.stat().st_uid == 0


@then("the directory owned by root is still empty")
def step_impl(context: TestContext):
    d = Path(context.tmpdir, SECRET_DIR_NAME)
    assert d.is_dir()
    assert not d.is_symlink()
    assert d.stat().st_uid == 0
    assert not any(d.iterdir())
