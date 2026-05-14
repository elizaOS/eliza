@product @not_release_blocker
Feature: Emergency shutdown
  As a Tails user
  when I unplug my Tails device to trigger emergency shutdown
  I want the system memory to be free from sensitive data.

  # Test something close to real-world usage, without interfering,
  # i.e. without the "I prepare Tails for memory erasure tests" step;
  # and test that Tails eventually shuts down, which we don't do in
  # the following scenarios for test suite performance reasons.
  Scenario: Tails shuts down on DVD boot medium removal
    Given I have started Tails from DVD and logged in and the network is connected
    When I eject the boot medium
    Then Tails eventually shuts down

  Scenario: Tails erases memory on DVD boot medium removal: overlayfs read-write branch
    Given I have started Tails from DVD without network and logged in
    And I prepare Tails for memory erasure tests
    And I fill a 128 MiB file with a known pattern on the root filesystem
    And patterns cover at least 128 MiB in the guest's memory
    When I eject the boot medium
    And I wait for Tails to finish wiping the memory
    Then I find very few patterns in the guest's memory

  Scenario: Tails erases memory on DVD boot medium removal: vfat
    Given I have started Tails from DVD without network and logged in
    And I prepare Tails for memory erasure tests
    And I plug and mount a 128 MiB USB drive with a vfat filesystem
    And I fill the USB drive with a known pattern
    And I read the content of the test FS
    And patterns cover at least 90% of the test FS size in the guest's memory
    When I eject the boot medium
    And I wait for Tails to finish wiping the memory
    Then I find very few patterns in the guest's memory

  Scenario: Tails erases memory on DVD boot medium removal: LUKS-encrypted ext4
    Given I have started Tails from DVD without network and logged in
    And I prepare Tails for memory erasure tests
    And I plug and mount a 128 MiB USB drive with an ext4 filesystem encrypted with password "asdf"
    And I fill the USB drive with a known pattern
    And I read the content of the test FS
    And patterns cover at least 99% of the test FS size in the guest's memory
    When I eject the boot medium
    And I wait for Tails to finish wiping the memory
    Then I find very few patterns in the guest's memory

  Scenario: Tails erases memory and shuts down on USB boot medium removal: persistent data
    Given I have started Tails without network from a USB drive with a persistent partition enabled and logged in
    And I prepare Tails for memory erasure tests
    And I fill a 128 MiB file with a known pattern on the persistent filesystem
    And patterns cover at least 100 MiB in the guest's memory
    When I eject the boot medium
    And I wait for Tails to finish wiping the memory
    Then I find very few patterns in the guest's memory
    And Tails eventually shuts down
