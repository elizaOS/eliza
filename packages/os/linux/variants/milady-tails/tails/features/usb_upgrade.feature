@product
Feature: Upgrading an old Tails USB installation
  As a Tails user
  If I have an old version of Tails installed on a USB device
  and the USB device has a Persistent Storage
  I want to upgrade Tails on it
  and keep my Persistent Storage in the process

  # An issue with this feature is that scenarios depend on each
  # other. When editing this feature, make sure you understand these
  # dependencies (which are documented below).

  # Installation method inspired by the usb-install-tails-greeter
  # checkpoint, variations are using the old Tails USB image and a
  # different device name ("old" instead of "__internal")
  #
  # Boot the system to make sure resizing has happened, and to check
  # the system is sane (safe access rights, no persistence, etc.); end
  # with unplugging to get both a clean state and a stopped machine.
  Scenario: Installing an old version of Tails to a pristine USB drive
    Given a computer
    And I create a 7200 MiB disk named "old"
    And I plug USB drive "old"
    And I write an old version of the Tails USB image to disk "old"
    When I start Tails from USB drive "old" with network unplugged
    Then the boot device has safe access rights
    And Tails is running from USB drive "old"
    And there is no persistence partition on USB drive "old"
    And process "udev-watchdog" is running
    And udev-watchdog is monitoring the correct device
    And I unplug USB drive "old"

  # Depends on scenario: Installing an old version of Tails to a pristine USB drive
  Scenario: Creating a persistent partition with the old Tails USB installation
    Given a computer
    And I start Tails from USB drive "old" with network unplugged and I login
    Then Tails is running from USB drive "old"
    And I create a persistent partition
    And I take note of which tps features are available
    Then a Tails persistence partition exists on USB drive "old"
    And I shutdown Tails and wait for the computer to power off

  # Depends on scenario: Creating a persistent partition with the old Tails USB installation
  Scenario: Writing files to a read/write-enabled persistent partition with the old Tails USB installation
    Given a computer
    And I start Tails from USB drive "old" with network unplugged and I login with persistence enabled
    Then Tails is running from USB drive "old"
    And all tps features are active
    When I write some files expected to persist
    # Verify that our baseline for the next scenarios is sane
    And all persistent filesystems have safe access rights
    And all persistence configuration files have safe access rights
    And all persistent directories from the old Tails version have safe access rights
    And I take note of which tps features are available
    And I shutdown Tails and wait for the computer to power off
    # XXX: how does guestfs work vs snapshots?
    Then only the expected files are present on the persistence partition on USB drive "old"

  # Depends on scenario: Writing files to a read/write-enabled persistent partition with the old Tails USB installation
  Scenario: Upgrading an old Tails USB installation from another Tails USB drive
    Given I have started Tails without network from a USB drive without a persistent partition and stopped at Tails Greeter's login screen
    And I log in to a new session
    And I clone USB drive "old" to a new USB drive "to_upgrade"
    And I plug USB drive "to_upgrade"
    When I upgrade Tails to USB drive "to_upgrade" by cloning
    Then the running Tails is installed on USB drive "to_upgrade"
    And I unplug USB drive "to_upgrade"
    And I unplug USB drive "__internal"

  # Depends on scenario: Upgrading an old Tails USB installation from another Tails USB drive
  Scenario: Booting Tails from a USB drive upgraded from USB with persistence enabled
    Given a computer
    And I start Tails from USB drive "to_upgrade" with network unplugged and I login with persistence enabled
    Then all tps features from the old Tails version are active
    And Tails is running from USB drive "to_upgrade"
    And the boot device has safe access rights
    And the expected persistent files created with the old Tails version are present in the filesystem
    And all persistent directories from the old Tails version have safe access rights

  @automatic_upgrade
  Scenario: Upgrading an initial Tails installation with an incremental upgrade
    Given I have started Tails without network from a USB drive with a persistent partition enabled and logged in
    And no SquashFS delta is installed
    And Tails is fooled to think that version 6.0~testoverlayfs was initially installed
    And Tails is fooled to think it is running version 6.0~testoverlayfs
    And the file system changes introduced in version 6.2~testoverlayfs are not present
    And the file system changes introduced in version 6.3~testoverlayfs are not present
    When the network is plugged
    And Tor is ready
    Then I am proposed to install an incremental upgrade to version 6.2~testoverlayfs
    And I can successfully install the incremental upgrade to version 6.2~testoverlayfs
    Given I shutdown Tails and wait for the computer to power off
    When I start Tails from USB drive "__internal" with network unplugged and I login with persistence enabled
    Then Tails is running version 6.2~testoverlayfs
    And all tps features are active
    And the file system changes introduced in version 6.2~testoverlayfs are present
    And only the 6.2~testoverlayfs SquashFS delta is installed
    # Our IUK sets a release date that can make Tor bootstrapping impossible
    Given Tails system time is magically synchronized
    # We'll really install Tails_amd64_6.0~testoverlayfs_to_6.3~testoverlayfs.iuk
    # but we need some way to force upgrading a second time in a row
    # even if only the initially installed version is considered
    And Tails is fooled to think that version 6.1~testoverlayfs was initially installed
    When the network is plugged
    And Tor is ready
    Then I am proposed to install an incremental upgrade to version 6.3~testoverlayfs
    And I can successfully install the incremental upgrade to version 6.3~testoverlayfs
    Given I shutdown Tails and wait for the computer to power off
    When I start Tails from USB drive "__internal" with network unplugged and I login with persistence enabled
    Then Tails is running version 6.3~testoverlayfs
    And all tps features are active
    And the file system changes introduced in version 6.3~testoverlayfs are present
    And only the 6.3~testoverlayfs SquashFS delta is installed
    # Regression test for #17425 (i.e. the Upgrader would propose
    # upgrading to the version that's already running)
    Given Tails system time is magically synchronized
    And Tails is fooled to think that version 6.1~testoverlayfs was initially installed
    When the network is plugged
    And Tor is ready
    Then the Upgrader considers the system as up-to-date
    # Regression test on #8158 (i.e. the IUK's filesystem is not part of the Unsafe Browser's chroot)
    And I successfully start the Unsafe Browser
    And the file system changes introduced in version 6.3~testoverlayfs are present in the Unsafe Browser's chroot

  @automatic_upgrade
  Scenario: Upgrading a Tails whose signing key is outdated
    Given I have started Tails without network from a USB drive with a persistent partition enabled and logged in
    And Tails is fooled to think that version 6.0~testoverlayfs was initially installed
    And Tails is fooled to think it is running version 6.0~testoverlayfs
    And the signing key used by the Upgrader is outdated
    But a current signing key is available on our website
    When the network is plugged
    And Tor is ready
    Then I am proposed to install an incremental upgrade to version 6.2~testoverlayfs
