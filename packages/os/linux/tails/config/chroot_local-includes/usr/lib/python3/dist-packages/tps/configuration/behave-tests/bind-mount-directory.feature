@tags: @requires_mountpoint
Feature: Bind-mounting directories
    Test the bind-mounting of directories with different preconditions and check
    that both the source and destination directories have the expected owner and
    permissions (recursively).

    Background:
        Given a binding object for mounting a directory "foo" to "foo" in the destination directory

    Scenario: Neither source nor destination directory exist
        When the binding is activated
        Then the source directory exists
        And the source directory is empty
        And the source directory is owned by root
        And the destination directory exists
        And the destination directory is empty
        And the destination directory is owned by root

    Scenario: Only the source directory exists
        Given the source directory exists
        When the binding is activated
        Then the destination directory is owned by root
        And the source and destination directories have the same owner and permissions recursively

    Scenario: Only the source directory exists and is owned by amnesia
        Given the source directory exists
        And the source directory is owned by amnesia
        When the binding is activated
        Then the destination directory is owned by amnesia
        And the source and destination directories have the same owner and permissions recursively

    Scenario: Only the source directory exists and contains a file owned by amnesia
        Given the source directory exists
        And the source directory contains a file owned by amnesia
        When the binding is activated
        Then the destination directory is owned by root
        And the destination directory contains a file owned by amnesia
        And the source and destination directories have the same owner and permissions recursively

    Scenario: Only the destination directory exists
        Given the destination directory exists
        When the binding is activated
        Then the source directory is owned by root
        And the source and destination directories have the same owner and permissions recursively

    Scenario: Only the destination directory exists and is owned by a amnesia
        Given the destination directory exists
        And the destination directory is owned by amnesia
        When the binding is activated
        Then the source directory is owned by amnesia
        And the source and destination directories have the same owner and permissions recursively

    Scenario: Only the destination directory exists and contains a file owned by amnesia
        Given the destination directory exists
        And the destination directory contains a file owned by amnesia
        When the binding is activated
        Then the source directory is owned by root
        # If the source directory does not exist, the destination directory
        # should be copied to the source, so it should also contain the file now
        And the source directory contains a file owned by amnesia
        And the source and destination directories have the same owner and permissions recursively

    Scenario: Both the destination directory and the source directory exist
        Given the destination directory exists
        And the source directory exists
        When the binding is activated
        Then the source directory is owned by root
        And the source and destination directories have the same owner and permissions recursively

    Scenario: Both source and destination exist and the source contains a file owned by amnesia
        Given the destination directory exists
        And the source directory exists
        And the source directory contains a file owned by amnesia
        When the binding is activated
        Then the destination directory contains a file owned by amnesia
        And the source and destination directories have the same owner and permissions recursively

    Scenario: Both source and destination exist and the destination contains a file owned by amnesia
        Given the destination directory exists
        And the source directory exists
        And the destination directory contains a file owned by amnesia
        When the binding is activated
        # The source was empty, so the destination should now be empty too
        Then the destination directory is empty
        And the source and destination directories have the same owner and permissions recursively

    Scenario: Destination directory created below /home/amnesia is owned by amnesia
        Given the path of the destination directory is below /home/amnesia
        When the binding is activated
        Then the destination directory is owned by amnesia

    @symlink_attack
    Scenario: The source does not exist and the destination is a symlink
        Given the destination is a symlink
        When the binding is tried to be activated
        Then binding activation fails with a MountException

    @symlink_attack
    Scenario: The source directory exists and the destination is a symlink
        Given the source directory exists
        And the destination is a symlink
        When the binding is tried to be activated
        Then binding activation fails with a MountException

    @symlink_attack
    Scenario: The source directory exists and the destination is a broken symlink
        Given the source directory exists
        And the destination is a broken symlink
        When the binding is tried to be activated
        Then binding activation fails with a MountException
