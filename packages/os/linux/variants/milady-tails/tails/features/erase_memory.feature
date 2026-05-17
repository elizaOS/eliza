@product @slow @not_release_blocker
Feature: System memory erasure on shutdown
  As a Tails user
  when I shutdown Tails
  I want the system memory to be free from sensitive data.

# These tests rely on the Linux kernel's memory poisoning features.
# The feature is called "on shutdown" as this is the security guarantee
# we document, but in practice we test that some important bits of memory
# are erased _before_ shutdown, while for some others we really test
# behavior at shutdown time.

  Scenario: Erasure of memory freed by killed userspace processes
    Given I have started Tails from DVD without network and logged in
    And I prepare Tails for memory erasure tests
    When I start a process allocating 128 MiB of memory with a known pattern
    # Since Debian Trixie we only get 99.610% coverage (tails#21012)
    Then patterns cover at least 127 MiB in the guest's memory
    When I kill the allocating process
    Then I find very few patterns in the guest's memory after 5 seconds

  Scenario: Erasure of tmpfs data on unmount
    Given I have started Tails from DVD without network and logged in
    And I prepare Tails for memory erasure tests
    And I find very few patterns in the guest's memory
    When I mount a 128 MiB tmpfs on "/mnt" and fill it with a known pattern
    Then patterns cover at least 99% of the test FS size in the guest's memory
    When I umount "/mnt"
    Then I find very few patterns in the guest's memory after 3 seconds

  Scenario: Erasure of read and write disk caches on unmount: vfat
    Given I have started Tails from DVD without network and logged in
    And I prepare Tails for memory erasure tests
    When I plug and mount a 128 MiB USB drive with a vfat filesystem
    Then I find very few patterns in the guest's memory
    # write cache
    When I fill the USB drive with a known pattern
    Then patterns cover at least 75% of the test FS size in the guest's memory
    When I umount the USB drive
    Then I find very few patterns in the guest's memory after 3 seconds
    # read cache
    When I mount the USB drive again
    And I read the content of the test FS
    Then patterns cover at least 99% of the test FS size in the guest's memory
    When I umount the USB drive
    Then I find very few patterns in the guest's memory after 3 seconds

  Scenario: Erasure of read and write disk caches on unmount: LUKS-encrypted ext4
    Given I have started Tails from DVD without network and logged in
    And I prepare Tails for memory erasure tests
    When I plug and mount a 128 MiB USB drive with an ext4 filesystem encrypted with password "asdf"
    Then I find very few patterns in the guest's memory
    # write cache
    When I fill the USB drive with a known pattern
    Then patterns cover at least 99% of the test FS size in the guest's memory
    When I umount the USB drive
    Then I find very few patterns in the guest's memory after 3 seconds
    # read cache
    When I mount the USB drive again
    And I read the content of the test FS
    Then patterns cover at least 99% of the test FS size in the guest's memory
    When I umount the USB drive
    Then I find very few patterns in the guest's memory after 3 seconds

  Scenario: Erasure of the overlayfs read-write branch on shutdown
    Given I have started Tails from DVD without network and logged in
    And I prepare Tails for memory erasure tests
    When I fill a 128 MiB file with a known pattern on the root filesystem
    # ensure the pattern is in memory due to tmpfs, not to disk cache
    And I drop all kernel caches
    Then patterns cover at least 128 MiB in the guest's memory
    When I trigger shutdown
    Then I find very few patterns in the guest's memory after 20 seconds

  Scenario: Erasure of read and write disk caches of persistent data on shutdown
    Given I have started Tails without network from a USB drive with a persistent partition enabled and logged in
    And I prepare Tails for memory erasure tests
    When I fill a 128 MiB file with a known pattern on the persistent filesystem
    When I trigger shutdown
    Then I find very few patterns in the guest's memory after 20 seconds
