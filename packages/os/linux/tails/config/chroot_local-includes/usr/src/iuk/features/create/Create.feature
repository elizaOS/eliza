Feature: create an IUK
  As a Tails developer,
  when I have prepared a new release,
  I want to build an IUK from the previous Tails release to the new one.

  Background:
    Given a usable temporary directory

  Scenario: create an IUK
    Given an old ISO image
    And a new ISO image
    When I create an IUK
    Then the created IUK is a SquashFS image
    Then the overlay directory in the saved IUK contains a SquashFS diff
    And the overlay directory contains an upgraded syslinux configuration
    And all files in the saved IUK belong to owner 0 and group 0

  Scenario: create an IUK with deleted files in a monitored directory of the ISO filesystem
    Given an old ISO image that contains file "live/a"
    And a new ISO image that does not contain file "live/a"
    When I create an IUK
    Then the delete_files list contains "live/a"

  Scenario: create an IUK with deleted files in a non-monitored directory of the ISO filesystem
    Given an old ISO image that contains file "whatever.dir/a"
    And a new ISO image that does not contain file "whatever.dir/a"
    When I create an IUK
    Then the delete_files list does not contain "whatever.dir/a"

  Scenario: create an IUK from identical ISO images
    Given two identical ISO images
    When I create an IUK
    Then the delete_files list is empty
    And the overlay directory contains an upgraded syslinux configuration

  Scenario: create an IUK when the kernel was not upgraded
    Given two ISO images that contain the same set of kernels
    When I create an IUK
    Then the overlay directory in the saved IUK does not contain "live/vmlinuz"
    And the overlay directory in the saved IUK does not contain "live/initrd.img"
    And the overlay directory in the saved IUK does not contain "live/vmlinuz2"
    And the overlay directory in the saved IUK does not contain "live/initrd2.img"
    And the overlay directory contains an upgraded syslinux configuration

  Scenario: create an IUK when the kernel was upgraded
    Given two ISO images when the kernel was upgraded
    When I create an IUK
    Then the overlay directory in the saved IUK contains "live/vmlinuz"
    And the overlay directory in the saved IUK contains "live/initrd.img"
    And the overlay directory in the saved IUK does not contain "filesystem.squashfs"
    And the overlay directory in the saved IUK does not contain "filesyst.squ"
    And the overlay directory contains an upgraded syslinux configuration

  Scenario: create an IUK when a new kernel was added
    Given two ISO images when a new kernel was added
    When I create an IUK
    Then the overlay directory in the saved IUK does not contain "live/vmlinuz"
    And the overlay directory in the saved IUK does not contain "live/initrd.img"
    And the overlay directory in the saved IUK contains "live/vmlinuz2"
    And the overlay directory in the saved IUK contains "live/initrd2.img"
    And the overlay directory contains an upgraded syslinux configuration

  Scenario: create an IUK when new files have appeared in filesystem.squashfs
    Given an old ISO image whose filesystem.squashfs does not contain file "A"
    And a new ISO image whose filesystem.squashfs contains file "A" owned by www-data
    When I create an IUK
    Then the saved IUK contains a SquashFS that contains file "A" owned by www-data

  Scenario: create an IUK when files have disappeared from filesystem.squashfs
    Given an old ISO image whose filesystem.squashfs contains file "A"
    And a new ISO image whose filesystem.squashfs does not contains file "A"
    When I create an IUK
    Then the saved IUK contains a SquashFS that deletes file "A"

  @xattr
  Scenario: create an IUK when files have been upgraded in filesystem.squashfs
    Given an old ISO image whose filesystem.squashfs contains file "system-systemd\\x2dcryptsetup.slice" modified at 1333333333
    And a new ISO image whose filesystem.squashfs contains file "system-systemd\\x2dcryptsetup.slice" modified at 1336666666
    When I create an IUK
    Then the saved IUK contains a SquashFS that contains file "system-systemd\\x2dcryptsetup.slice" modified at SOURCE_DATE_EPOCH

  Scenario: create an IUK when the bootloader configuration was not upgraded
    Given two ISO images that contain the same bootloader configuration
    When I create an IUK
    Then the saved IUK contains an "overlay" directory
    And the overlay directory contains an upgraded syslinux configuration

  Scenario: create an IUK when the bootloader configuration was upgraded
    Given two ISO images that do not contain the same bootloader configuration
    When I create an IUK
    Then the saved IUK contains the new bootloader configuration
    And the overlay directory contains an upgraded syslinux configuration

  Scenario: create an IUK without passing a product name

  Scenario: create an IUK without passing an old version number

  Scenario: create an IUK without passing a new version number

  Scenario: create an IUK without passing a build target
