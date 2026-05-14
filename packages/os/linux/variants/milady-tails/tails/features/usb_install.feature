@product
Feature: Installing Tails to a USB drive
  As a Tails user
  I want to install Tails to a suitable USB drive

  @not_release_blocker
  Scenario: Try installing Tails to a too small USB drive with GPT and a FAT partition
    Given I have started Tails from DVD without network and logged in
    And I temporarily create a 4 GiB disk named "gptfat"
    And I create a gpt partition with a vfat filesystem on disk "gptfat"
    And I plug USB drive "gptfat"
    When I start Tails Installer
    Then I am told by Tails Installer that the destination device "is too small"

  Scenario: Detecting when a target USB drive is inserted or removed
    Given I have started Tails from DVD without network and logged in
    And I temporarily create a 7200 MiB disk named "temp"
    And I start Tails Installer
    But a suitable USB device is not found
    When I plug USB drive "temp"
    Then the "temp" USB drive is selected
    When I unplug USB drive "temp"
    Then a suitable USB device is not found

  Scenario: Installing Tails with Tails Installer to a used USB drive
    Given I have started Tails from DVD without network and logged in
    And I temporarily create a 7200 MiB disk named "install"
    And I create a gpt partition with a vfat filesystem on disk "install"
    And I plug USB drive "install"
    And I install Tails to USB drive "install" by cloning
    Then the running Tails is installed on USB drive "install"
    And there is a random seed on USB drive "install"
    But there is no persistence partition on USB drive "install"

  Scenario: Installing Tails with Tails Installer to a pristine USB drive
    Given I have started Tails from DVD without network and logged in
    And I temporarily create a 7200 MiB disk named "install"
    And I plug USB drive "install"
    And I install Tails to USB drive "install" by cloning
    Then the running Tails is installed on USB drive "install"
    And there is a random seed on USB drive "install"
    But there is no persistence partition on USB drive "install"

  Scenario: Installing Tails with Tails Installer to a used USB drive, cloning the Persistent Storage
    Given I have started Tails without network from a USB drive with a persistent partition enabled and logged in
    And I create a file in the Persistent directory
    And I temporarily create a 7200 MiB disk named "install"
    And I create a gpt partition with a vfat filesystem on disk "install"
    And I plug USB drive "install"
    And I install Tails with Persistent Storage to USB drive "install" by cloning
    Then the running Tails is installed on USB drive "install"
    And there is a random seed on USB drive "install"
    And there is a persistence partition on USB drive "install"
    And the USB drive "install" contains the same files as my persistent storage

  Scenario: Installing Tails with Tails Installer to a pristine USB drive, without cloning the Persistent Storage
    Given I have started Tails without network from a USB drive with a persistent partition enabled and logged in
    And I temporarily create a 7200 MiB disk named "install"
    And I plug USB drive "install"
    And I install Tails to USB drive "install" by cloning
    Then the running Tails is installed on USB drive "install"
    And there is a random seed on USB drive "install"
    And there is no persistence partition on USB drive "install"

  Scenario: Re-installing Tails over an existing USB installation with a persistent partition
    # We reach this first checkpoint only to ensure that the ' __internal' disk has reached the state (Tails installed + persistent partition set up) we need before we clone it below.
    # This first part is done without Tails Installer (install from Tails USB image)
    # Note: the "__internal" disk will keep its state across scenarios
    # and features until one of its snapshots is restored.
    Given I have started Tails without network from a USB drive with a persistent partition enabled and logged in
    And I have started Tails from DVD without network and logged in
    And I clone USB drive "__internal" to a temporary USB drive "install"
    And I plug USB drive "install"
    # This second part is done with Tails Installer, that's what this scenario is about
    When I reinstall Tails to USB drive "install" by cloning
    Then the running Tails is installed on USB drive "install"
    And there is a random seed on USB drive "install"
    And there is no persistence partition on USB drive "install"

  @uefi
  Scenario: Booting Tails from a USB drive in UEFI mode
    Given I have started Tails without network from a USB drive without a persistent partition and stopped at Tails Greeter's login screen
    And I power off the computer
    And the computer is set to boot in UEFI mode
    When I start Tails from USB drive "__internal" with network unplugged and I login
    Then Tails is running from USB drive "__internal"
    And the boot device has safe access rights
    And Tails has started in UEFI mode

  Scenario: Installing Tails with GNOME Disks from a USB image
    Given I have started Tails from DVD without network and logged in
    And I plug and mount a USB drive containing a Tails USB image
    And I create a 7200 MiB disk named "usbimage"
    And I plug USB drive "usbimage"
    And I install a Tails USB image to the 7200 MiB disk with GNOME Disks

  # Depends on scenario: Installing Tails with GNOME Disks from a USB image
  Scenario: The system partition is updated when booting from a USB drive where a Tails USB image was copied
    Given a computer
    And I start Tails from USB drive "usbimage" with network unplugged and I login
    Then Tails is running from USB drive "usbimage"
    And the label of the system partition on "usbimage" is "Tails"
    And the system partition on "usbimage" is an EFI system partition
    And the FAT filesystem on the system partition on "usbimage" is at least 4000M large
    And the UUID of the FAT filesystem on the system partition on "usbimage" was randomized
    And the label of the FAT filesystem on the system partition on "usbimage" is "TAILS"
    And the system partition on "usbimage" has the expected flags
