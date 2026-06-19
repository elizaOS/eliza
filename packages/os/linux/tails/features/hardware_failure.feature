@product
Feature: Hardware failures
  In order to update my failing hardware before I lose data
  As a Tails user
  I want to be warned about hardware failures

  @broken_welcome_screen
  Scenario Outline: Alerting about disk read failures before reaching the Welcome Screen
    Given a computer
    And <device> is damaged in a way that some read operations fail
    When I start the computer
    Then the computer boots Tails
    And I see a disk failure message on the splash screen
    Examples:
      | device |
      | SquashFS |
      | boot device |
      | boot device with a target error |

  @doc
  Scenario Outline: Alerting about disk read failures in GNOME
    Given a computer
    And I have started Tails without network from a USB drive with a persistent partition enabled and logged in
    When Tails detects disk read failures on the <device>
    Then I see a disk failure message
    Then I can open the hardware failure documentation from the disk failure message
    Examples:
      | device |
      | SquashFS |
      | boot device |
      | boot device with a target error |

  Scenario Outline: GPT backup corruption with a persistent partition
    Given I have started Tails without network from a USB drive with a persistent partition and stopped at Tails Greeter's login screen
    And I corrupt the boot device's GPT backup <thing>
    And I power off the computer
    When I start the computer
    Then the computer boots Tails
    When I log in to a new session
    And all notifications have disappeared
    Then I am recommended to migrate to a new USB stick due to partitioning errors
    And Tails detected partitioning error partitioning-corruption
    Examples:
    | thing           |
    | header          |
    | partition table |

  Scenario: GPT backup corruption without a persistent partition
    Given a computer
    And I set Tails to boot with options "test_gpt_corruption=gpt_backup,gpt_backup_table"
    And I temporarily create a 7200 MiB disk named "temp"
    And I plug USB drive "temp"
    And I write the Tails USB image to disk "temp"
    When I start Tails from USB drive "temp" with network unplugged
    Then Tails is running from USB drive "temp"
    And the Greeter forbids creating a persistent partition
    When I log in to a new session
    And all notifications have disappeared
    Then I am recommended to reinstall Tails due to partitioning errors
    # We are gonna verify the dialog again so we need to clean up the
    # first instance.
    And I close the "zenity" window
    And I am told that Persistent Storage cannot be created
    And Tails detected partitioning error partitioning-corruption

  Scenario Outline: Disk partitioning errors without a persistent partition
    Given a computer
    And I set Tails to boot with options "test_partitioning_errors=<error>"
    And I temporarily create a 7200 MiB disk named "temp"
    And I plug USB drive "temp"
    And I write the Tails USB image to disk "temp"
    When I start Tails from USB drive "temp" with network unplugged
    Then Tails is running from USB drive "temp"
    And the Greeter recommends reinstalling Tails due to partitioning errors
    And the Greeter forbids starting Tails
    And the Greeter forbids all settings but language
    And Tails detected partitioning error <reason>
    Examples:
      | error       | reason                       |
      | guid        | guid-not-randomized          |
      | part_resize | system-partition-not-resized |
      | fs_resize   | fs-not-resized               |
