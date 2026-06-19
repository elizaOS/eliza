@tags: @requires_mountpoint
Feature: Symlink directories
    Test the "mounting" of directories via symlinks with different preconditions
    and check that both the source and destination directories have the expected
    owner and permissions (recursively).

    Background:
        Given a binding object for symlinking a directory "foo" to "foo" in the destination directory

    Scenario: Neither source nor destination directory exist
        When the binding is activated
        Then the source directory exists
        And the destination directory exists
        And the destination directory contains no symlink

    Scenario: Only the destination directory exists
        Given the destination directory exists
        When the binding is activated
        Then the source directory exists
        And the destination directory exists
        And the destination directory contains no symlink

    Scenario: Only the source directory exists and is empty
        Given the source directory exists
        When the binding is activated
        Then the source directory exists
        And the destination directory exists
        And the destination directory contains no symlink

    Scenario: Only the source directory exists and contains a file owned by root
        Given the source directory exists
        And the source directory contains a file owned by root
        When the binding is activated
        Then the destination directory is owned by root
        And the destination directory contains symlinks to all the files in the source directory
        And the destination directory contains a symlink to a file owned by root

    Scenario: Only the source directory exists and contains a file owned by amnesia
        # Same as above, but the symlink should be owned by amnesia
        Given the source directory exists
        And the source directory contains a file owned by amnesia
        When the binding is activated
        Then the destination directory is owned by root
        And the destination directory contains symlinks to all the files in the source directory
        And the destination directory contains a symlink to a file owned by amnesia

    Scenario: Both the destination directory and the source directory exist
        Given the destination directory exists
        And the source directory exists
        When the binding is activated
        Then the destination directory contains no symlink

    Scenario: Both source and destination exist and the source contains a file owned by amnesia
        Given the destination directory exists
        And the source directory exists
        And the source directory contains a file owned by amnesia
        When the binding is activated
        Then the destination directory contains symlinks to all the files in the source directory
        And the destination directory contains a symlink to a file owned by amnesia

    Scenario: The source directory contains a valid symlink
        Given the destination directory exists
        And the source directory exists
        And the source directory contains a valid symlink
        When the binding is activated
        Then the destination directory contains a symlink to a valid symlink

    Scenario: The source directory contains a broken symlink
        Given the destination directory exists
        And the source directory exists
        And the source directory contains a broken symlink
        When the binding is activated
        Then the destination directory contains a symlink to a broken symlink

    @symlink_attack
    Scenario: Destination directory already contains a symlink
        Given the destination directory exists
        And the source directory exists
        And the source directory contains a file owned by amnesia
        And the destination directory contains a file of the same name, which is a symlink to a file owned by root
        When the binding is activated
        Then the destination directory contains symlinks to all the files in the source directory
        And the file owned by root was not changed

    @symlink_attack
    Scenario: The destination is a symlink
        Given the source directory exists
        And the source directory contains a file owned by amnesia
        And the destination is a symlink to an empty directory owned by root
        When the binding is tried to be activated
        Then binding activation fails with OSError ELOOP
        And the directory owned by root is still empty
