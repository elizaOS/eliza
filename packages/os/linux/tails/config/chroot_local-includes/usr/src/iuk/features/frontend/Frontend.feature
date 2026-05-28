Feature: upgrade frontend
  As a Tails user
  I want to be guided through upgrading my Tails system, if needed

  Background:
    Given a Tails boot device
    And a trusted OpenPGP signing key pair
    And an HTTPS server with a valid SSL certificate

  Scenario: manually installed USB: no upgrade is available
    Given Tails is running from a manually installed USB thumb drive
    And no upgrade is available
    When I run tails-upgrade-frontend in batch mode
    Then it should succeed
    And I should be told "The system is up-to-date"

  Scenario: manually installed USB: no incremental upgrade is available, but a full upgrade is
    Given Tails is running from a manually installed USB thumb drive
    And no incremental upgrade is available, but a full upgrade is
    When I run tails-upgrade-frontend in batch mode
    Then it should succeed
    And I should be proposed to download this full upgrade

  Scenario: manually installed USB: both incremental and full upgrades are available
    Given Tails is running from a manually installed USB thumb drive
    And both incremental and full upgrades are available
    When I run tails-upgrade-frontend in batch mode
    Then it should succeed
    And I should be proposed to download this full upgrade
    And I should be told "your device was not created using a USB image or Tails Cloner"

  Scenario: DVD: no upgrade is available
    Given Tails is running from a DVD
    And no upgrade is available
    When I run tails-upgrade-frontend in batch mode
    Then it should succeed
    And I should be told "The system is up-to-date"

  Scenario: DVD: no incremental upgrade is available, but a full upgrade is
    Given Tails is running from a DVD
    And no incremental upgrade is available, but a full upgrade is
    When I run tails-upgrade-frontend in batch mode
    Then it should succeed
    And I should be proposed to download this full upgrade

  Scenario: DVD: both incremental and full upgrades are available
    Given Tails is running from a DVD
    And both incremental and full upgrades are available
    When I run tails-upgrade-frontend in batch mode
    Then it should succeed
    And I should be proposed to download this full upgrade
    And I should be told "Tails was started from a DVD or a read-only device"

  Scenario: USB produced by our installer: no upgrade available
    Given Tails is running from a USB thumb drive
    And no upgrade is available
    When I run tails-upgrade-frontend
    Then it should succeed
    And I should be told "The system is up-to-date"

  Scenario: USB produced by our installer: cannot determine whether an upgrade is available
    Given Tails is running from a USB thumb drive
    And it is not known whether an upgrade is available
    When I run tails-upgrade-frontend
    Then it should fail to check for upgrades
    And I should be told "Could not determine whether an upgrade is available"

  @mirrors
  Scenario: USB produced by our installer: installing an incremental upgrade
    Given Tails is running from a USB thumb drive
    And both incremental and full upgrades are available
    When I run tails-upgrade-frontend in batch mode
    Then it should succeed
    And I should be proposed to install this incremental upgrade
    And I should be told "Downloading the upgrade"
    And I should be asked to wait
    And I should be told "Upgrade successfully downloaded"
    And I should be told "The network connection will be disabled"
    And the network should be shutdown
    And I should be told "Your Tails device is being upgraded"
    And I should be told "the network connection is now disabled"
    And I should be asked to wait
    And the downloaded IUK should be installed
    And I should be proposed to restart the system
    And the system should be restarted
    When I run tails-upgrade-frontend in batch mode
    Then it should succeed
    And I should be told "The system is up-to-date"

  Scenario: USB produced by our installer: no incremental upgrade is available, but a full upgrade is
    Given Tails is running from a USB thumb drive
    And no incremental upgrade is available, but a full upgrade is
    When I run tails-upgrade-frontend in batch mode
    Then it should succeed
    And I should be proposed to download this full upgrade

  Scenario: USB produced by our installer: both incremental and full upgrades are available, but a target file does not exist
    Given Tails is running from a USB thumb drive
    And both incremental and full upgrades are available
    And a target file does not exist
    When I run tails-upgrade-frontend in batch mode
    Then it should fail to download the upgrade
    And I should be proposed to install this incremental upgrade
    And I should be told "Downloading the upgrade"
    And I should be told "Error while downloading the upgrade"
    And I should be told "The upgrade could not be downloaded"
    And I should be told "request failed"

  Scenario: USB produced by our installer: both incremental and full upgrades are available, but a target file is corrupted
    Given Tails is running from a USB thumb drive
    And both incremental and full upgrades are available
    And a target file is corrupted
    When I run tails-upgrade-frontend in batch mode
    Then it should fail to download the upgrade
    And I should be proposed to install this incremental upgrade
    And I should be told "Downloading the upgrade"
    And I should be told "Error while downloading the upgrade"
    And I should be told "was downloaded but its size"

  Scenario: USB produced by our installer: not enough free memory
    Given Tails is running from a USB thumb drive
    And both incremental and full upgrades are available
    And the system has not enough free memory to install this incremental upgrade
    When I run tails-upgrade-frontend in batch mode
    Then it should succeed
    And I should be proposed to download this full upgrade
    And I should be told "requires .+ of free memory, but only .+ is available"
    And I should be told "not enough memory is available on this system"

  Scenario: USB produced by our installer: not enough free space on the system partition
    Given Tails is running from a USB thumb drive
    And both incremental and full upgrades are available
    And the system partition has not enough free space to install this incremental upgrade
    When I run tails-upgrade-frontend in batch mode
    Then it should succeed
    And I should be proposed to download this full upgrade
    And I should be told "requires .+ of free space on Tails system partition"
    And I should be told "not enough free space on the Tails system partition"
