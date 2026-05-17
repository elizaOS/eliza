import logging
import os
from pathlib import Path
import shutil
import subprocess
from tempfile import mkdtemp
import unittest
from unittest import TestCase
from unittest.mock import Mock
import sys

# To be able to run the tests without installing the module first, we
# tell Python where it can find the tps module relative to the script
# directory.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(SCRIPT_DIR, "..", ".."))

# Ensure tps/__init__.py does not try to connect to UDisks:
# we don't need it here and it may not be running.
os.environ["NO_UDISKS"] = "1"

from tps.configuration.config_file import (
    ConfigFile,
    InvalidStatError,
)  # noqa: E402,E501
from tps.configuration.binding import Binding  # noqa: E402

logging.basicConfig(level=logging.DEBUG)

test_features = [
    Mock(
        Bindings=[
            Binding("foo", "/dest/foo"),
            Binding("bar", "/dest/bar"),
            Binding("dotfiles", "/dest", uses_symlinks=True),
        ]
    ),
    Mock(
        Bindings=[
            Binding("foo", "/dest/foo"),
            Binding("bla bla", "/dest/bla bla"),
        ]
    ),
]


class ConfigFileTestCase(TestCase):
    mount_point: str
    config_file: ConfigFile
    path: Path

    @classmethod
    def setUpClass(cls):
        """Create a temporary config file which is used for the tests"""
        cls.mount_point = mkdtemp(prefix="TailsData-")
        cls.config_file = ConfigFile(cls.mount_point)
        cls.path = Path(cls.config_file.path)

    @classmethod
    def tearDownClass(cls):
        """Delete the temporary config file"""
        if os.getenv("SKIP_CLEANUP"):
            return
        shutil.rmtree(cls.mount_point)

    @classmethod
    def create_valid_config_file(cls):
        # Ensure the config file does not exist from previous tests
        try:
            cls.path.unlink()
        except FileNotFoundError:
            pass
        # Create a new config file with the expected file permissions
        cls.path.touch(mode=0o100600)


class TestCheckFileStat(ConfigFileTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()

        # To be able to test behavior of config files owned by another
        # user, we need root privileges to run this test.
        if os.geteuid() != 0:
            exit("You need to have root privileges to run this test")

    def test_valid_config_file(self):
        self.create_valid_config_file()
        self.config_file.check_file_stat()

    def test_invalid_nonexistent(self):
        # Ensure that no config file exists
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass

        # Check that an exception is raised
        with self.assertRaises(InvalidStatError):
            self.config_file.check_file_stat()

    def test_invalid_uid(self):
        # Create a valid config file
        self.create_valid_config_file()

        # Check that an exception is raised if the config file has a
        # different UID than our current user, by setting the owner
        # to UID 1000 (we run as root, so we have UID 0)
        os.chown(self.path, 1000, -1)
        with self.assertRaises(InvalidStatError):
            self.config_file.check_file_stat()

    def test_invalid_gid(self):
        # Create a valid config file
        self.create_valid_config_file()

        # Check that an exception is raised if the config file has a
        # different GID than our current user, by setting the owner
        # to UID 1000 (we run as root, so we have UID 0)
        os.chown(self.path, -1, 1000)
        with self.assertRaises(InvalidStatError):
            self.config_file.check_file_stat()

    def test_invalid_file_type(self):
        # Ensure the config file does not exist from previous tests
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass

        # Check that an exception is raised if a directory exists
        # at the config file path
        self.path.mkdir()
        with self.assertRaises(InvalidStatError):
            self.config_file.check_file_stat()
        self.path.rmdir()

        # Check that an exception is raised if the config file is a
        # symlink
        self.path.symlink_to("/proc/cmdline")
        with self.assertRaises(InvalidStatError):
            self.config_file.check_file_stat()
        self.path.unlink()

    def test_invalid_permissions(self):
        self.create_valid_config_file()

        # Check that an exception is raised if the config file has
        # unsafe permissions
        os.chmod(self.path, 0o644)
        with self.assertRaises(InvalidStatError):
            self.config_file.check_file_stat()

    def test_invalid_acl(self):
        self.create_valid_config_file()

        # Check that an exception is raised if the config file has
        # unsafe permissions
        subprocess.check_call(["setfacl", "-m", "u:1000:rwX", self.path])
        with self.assertRaises(InvalidStatError):
            self.config_file.check_file_stat()


class TestDisableAndCreateEmpty(ConfigFileTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()

    def assert_empty_file(self):
        self.assertTrue(self.config_file.path.exists())
        self.assertEqual("", self.config_file.path.read_text())

    def test(self):
        # Create a config file
        self.create_valid_config_file()
        old_path = self.path

        # Call disable_and_create_empty
        self.config_file.disable_and_create_empty()

        # Check if the valid file was renamed
        self.assertTrue(Path(str(old_path) + ".invalid"))

        # Check if an empty file was created
        self.assert_empty_file()


class TestContains(ConfigFileTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.create_valid_config_file()

    def assert_contains_features(self, content: str, features):
        if not isinstance(features, list):
            features = [features]

        # Write the content to the config file
        self.path.write_text(content)

        # Assert that the config file contains all the expected features
        self.assertTrue(all(self.config_file.contains(feature) for feature in features))

    def test_feature_1(self):
        # Check that test feature 1 can be extracted
        self.assert_contains_features(
            """
            /dest/foo source=foo
            /dest/bar source=bar
            /dest    source=dotfiles,link
            """,
            test_features[0],
        )

    def test_feature_1_reordered(self):
        # Same as above, but with a different order of lines and options
        self.assert_contains_features(
            """
            /dest/bar source=bar
            /dest    link,source=dotfiles
            /dest/foo source=foo
            """,
            test_features[0],
        )

    def test_feature_2(self):
        # Check that test feature 2 can be extracted.
        self.assert_contains_features(
            """
            /dest/bla\ bla source=bla\ bla
            /dest/foo source=foo
            """,
            test_features[1],
        )

    def test_feature_1_and_2(self):
        # Check that test features 1 and 2 can be extracted at once
        self.assert_contains_features(
            """
            /dest/foo source=foo
            /dest/bar source=bar
            /dest/bla\ bla source=bla\ bla
            /dest    link,source=dotfiles
            """,
            [test_features[0], test_features[1]],
        )

    def test_feature_1_incomplete(self):
        # Check that test feature 1 can not be extracted if only parts
        # of its lines are written to the config file
        # file
        self.assert_contains_features(
            """
            /dest/foo source=foo
            /dest/bar source=bar
            """,
            [],
        )


class TestParse(ConfigFileTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.create_valid_config_file()

    def assert_parses_bindings_of_features(self, content: str, features):
        if not isinstance(features, list):
            features = [features]

        # Get the list of all bindings of the features
        bindings = list()
        for feature in features:
            bindings += feature.Bindings

        # Write the content to the config file
        self.path.write_text(content)

        # Parse bindings
        parsed = self.config_file.parse()

        # Assert that the expected bindings were extracted
        self.assertEqual(set(bindings), set(parsed))

    def test_feature_1(self):
        # Check that test feature 1 can be extracted
        self.assert_parses_bindings_of_features(
            """
            /dest/foo source=foo
            /dest/bar source=bar
            /dest    source=dotfiles,link
            """,
            test_features[0],
        )

    def test_feature_2(self):
        # Check that test feature 2 can be extracted.
        self.assert_parses_bindings_of_features(
            """
            /dest/bla\ bla source=bla\ bla
            /dest/foo source=foo
            """,
            test_features[1],
        )

    def test_feature_1_and_2(self):
        # Check that test features 1 and 2 can be extracted at once
        self.assert_parses_bindings_of_features(
            """
            /dest/foo source=foo
            /dest/bar source=bar
            /dest/bla\ bla source=bla\ bla
            /dest    link,source=dotfiles
            """,
            [test_features[0], test_features[1]],
        )


class TestSave(ConfigFileTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()

    def assert_extracts_features(self, features):
        if not isinstance(features, list):
            features = [features]

        # Get the list of all bindings of the features
        bindings = list()
        for feature in features:
            bindings += feature.Bindings

        # Save the features
        self.config_file.save(features)

        # Parse features
        extracted = self.config_file.parse()

        # Assert that the expected bindings were extracted
        self.assertEqual(set(bindings), set(extracted))

    def test_feature_1(self):
        self.assert_extracts_features(test_features[0])

    def test_feature_2(self):
        self.assert_extracts_features(test_features[1])

    def test_all_features(self):
        self.assert_extracts_features(test_features)

    def test_no_features(self):
        self.assert_extracts_features([])

    def test_overwriting_config_file(self):
        # First, we save only test feature 1
        self.assert_extracts_features(test_features[0])
        # Then, we save only test feature 2, overwriting the config
        # file. This checks that only test feature 2 can be extracted
        # after the config file was overwritten.
        self.assert_extracts_features(test_features[1])


if __name__ == "__main__":
    # We set the module name explicitly to be able to run the tests
    # with `trace`, see https://stackoverflow.com/a/25300465.
    unittest.main("config_file_test", failfast=True, buffer=True)
