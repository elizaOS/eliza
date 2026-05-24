@product
Feature: Backing up the persistent storage
  As a Tails user
  I want to backup my persistent storage
  And easily keep that backup updated

  Scenario: Using Tails' custom backup tool to backup a newly added file
    Given I have started Tails without network from a USB drive with a persistent partition enabled and logged in
    # The volume cannot be in use when GuestFs clones it, which we do below
    And I shutdown Tails and wait for the computer to power off
    And I clone USB drive "__internal" to a temporary USB drive "backup"
    Given I have started Tails without network from a USB drive with a persistent partition enabled and logged in
    And I write a file "/live/persistence/TailsData_unlocked/new" with contents "foo"
    When I start Tails' custom backup tool
    Then the backup tool displays "Plug in your backup Tails USB stick"
    When I plug USB drive "backup"
    And I give the Persistent Storage on drive "backup" its own UUID
    And I click "Retry" in the backup tool
    Then the backup tool displays "Do you want to back up your Persistent Storage now?"
    When I click "Back Up" in the backup tool
    And I enter my persistent storage passphrase into the polkit prompt
    Then the backup tool displays "Your Persistent Storage was backed up successfully to your backup Tails USB stick!"
    # The backup tool ejects the drive, so we have to replug it
    When I unplug USB drive "backup"
    And I plug USB drive "backup"
    Then the USB drive "backup" contains the same files as my persistent storage
