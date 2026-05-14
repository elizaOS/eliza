@product
Feature: Tails has a sane default configuration

  Scenario: Users are set up correctly
    Given I have started Tails from DVD without network and logged in
    Then the live user has been setup by live-boot
    And the live user is a member of only its own group and "cdrom dialout floppy video plugdev netdev scanner lp lpadmin users"
    And the live user owns its home directory which has strict permissions
    And the root user owns its home directory which has strict permissions

  @not_release_blocker
  Scenario: No unexpected network services
    Given I have started Tails from DVD and logged in and the network is connected
    Then no unexpected services are listening for network connections

  Scenario: The live user can only access the expected local services
    Given I have started Tails from DVD and logged in and the network is connected
    Then the live user can only access allowed local services

  Scenario: No unexpected error messages in the journal after booting from DVD
    Given I have started Tails from DVD without network and logged in
    Then there are no unexpected messages of priority "err" or higher in the journal

  Scenario: No unexpected error messages in the journal after booting from USB drive
    Given I have started Tails without network from a USB drive with a persistent partition enabled and logged in
    Then there are no unexpected messages of priority "err" or higher in the journal
