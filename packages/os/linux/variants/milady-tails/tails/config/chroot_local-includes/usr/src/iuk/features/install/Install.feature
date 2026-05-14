Feature: install an IUK
  As a Tails user,
  Given the Tails upgrader proposes me to install an IUK that was downloaded and verified,
  When I accept,
  Then I want to get as a result either an upgraded system or an error message.

  Background:
    Given a 64MB Tails boot device with a blank MBR

  Scenario: attempt to install an IUK whose format version is not supported
    Given a "test1.iuk" IUK whose format version is not supported
    When I attempt to install the "test1.iuk" IUK
    Then it should fail
    And I should be told "Unsupported format"
    And the temporary directory on the system partition should be empty
    And the modules file should list 1 SquashFS
    And the last line of the modules file should be "filesystem.squashfs"

  Scenario: attempt to install an IUK whose format version is not an integer
    Given a "test1.iuk" IUK whose format version cannot be determined
    When I attempt to install the "test1.iuk" IUK
    Then it should fail
    And I should be told "Unsupported format"
    And the temporary directory on the system partition should be empty
    And the modules file should list 1 SquashFS
    And the last line of the modules file should be "filesystem.squashfs"

  Scenario: attempt to install an IUK that has no FORMAT file
    Given a "test1.iuk" IUK that has no FORMAT file
    When I attempt to install the "test1.iuk" IUK
    Then it should fail
    And I should be told "The format version cannot be determined"
    And the temporary directory on the system partition should be empty
    And the modules file should list 1 SquashFS
    And the last line of the modules file should be "filesystem.squashfs"

  Scenario: install an IUK that contains no SquashFS
    Given a "test1.iuk" IUK that contains 0 SquashFS
    And a running Tails that has no IUK installed
    When I install the "test1.iuk" IUK
    Then it should succeed
    And the system partition should contain 1 SquashFS
    And the temporary directory on the system partition should be empty
    And the modules file should list 1 SquashFS
    And the last line of the modules file should be "filesystem.squashfs"

  Scenario: install an IUK that contains one SquashFS
    Given a "test1.iuk" IUK that contains 1 SquashFS
    And a running Tails that has no IUK installed
    When I install the "test1.iuk" IUK
    Then it should succeed
    And the system partition should contain 2 SquashFS
    And the temporary directory on the system partition should be empty
    And the modules file should list 2 SquashFS
    And the last line of the modules file should be "test1-1.squashfs"

  Scenario: install an IUK that contains two SquashFS
    Given a "test1.iuk" IUK that contains 2 SquashFS
    And a running Tails that has no IUK installed
    When I install the "test1.iuk" IUK
    Then it should succeed
    And the system partition should contain 3 SquashFS
    And the temporary directory on the system partition should be empty
    And the modules file should list 3 SquashFS
    And the last line of the modules file should be "test1-2.squashfs"

  Scenario: install an IUK whose overlay directory contains one file
    Given a "test1.iuk" IUK whose overlay directory contains file "in_overlay_dir"
    When I install the "test1.iuk" IUK
    Then it should succeed
    And the system partition should contain file "in_overlay_dir"
    And the system partition should not contain file "not_in_overlay_dir"
    And the temporary directory on the system partition should be empty
    And the modules file should list 1 SquashFS
    And the last line of the modules file should be "filesystem.squashfs"

  Scenario: install an IUK that deletes files in the system partition
    Given a "test1.iuk" IUK that deletes files "a, non_existent, b/c" in the system partition
    And a system partition that contains file "a"
    And a system partition that contains file "b/c"
    And a system partition that contains file "d"
    When I install the "test1.iuk" IUK
    Then it should succeed
    And the system partition should not contain file "a"
    And the system partition should not contain file "b/c"
    And the system partition should contain file "d"
    And the temporary directory on the system partition should be empty
    And the modules file should list 1 SquashFS
    And the last line of the modules file should be "filesystem.squashfs"

  Scenario: install an IUK a second time in a row
    Given a "test1.iuk" IUK whose overlay directory contains file "in_overlay_dir"
    When I install the "test1.iuk" IUK
    Then it should succeed
    When I install the "test1.iuk" IUK
    Then it should succeed
    And the system partition should contain file "in_overlay_dir"
    And the temporary directory on the system partition should be empty
    And the modules file should list 1 SquashFS
    And the last line of the modules file should be "filesystem.squashfs"

  Scenario: install multiple IUK in a row
    Given a "test1.iuk" IUK whose overlay directory contains file "in_overlay_1"
    And a "test2.iuk" IUK whose overlay directory contains file "in_overlay_2"
    And a "test3.iuk" IUK that contains 1 SquashFS
    And a "test4.iuk" IUK that contains 1 SquashFS
    And a "test5.iuk" IUK that deletes files "a, non_existent, b/c" in the system partition
    And a "test6.iuk" IUK that deletes files "a, non_existent, b/c" in the system partition
    And a running Tails that has no IUK installed
    And a system partition that contains file "a"
    And a system partition that contains file "b/c"
    And a system partition that contains file "d"
    When I install the "test1.iuk" IUK
    Then it should succeed
    And the system partition should contain 1 SquashFS
    When I install the "test2.iuk" IUK
    Then it should succeed
    And the system partition should contain 1 SquashFS
    When I install the "test3.iuk" IUK
    Then it should succeed
    And the system partition should contain 2 SquashFS
    And the last line of the modules file should be "test3-1.squashfs"
    And the modules file should list 2 SquashFS
    When I install the "test4.iuk" IUK
    Then it should succeed
    And the system partition should contain 2 SquashFS
    And the last line of the modules file should be "test4-1.squashfs"
    And the modules file should list 2 SquashFS
    When I install the "test5.iuk" IUK
    Then it should succeed
    And the system partition should contain 1 SquashFS
    And the modules file should list 1 SquashFS
    And the last line of the modules file should be "filesystem.squashfs"
    When I install the "test6.iuk" IUK
    Then it should succeed
    And the system partition should contain 1 SquashFS
    And the modules file should list 1 SquashFS
    And the last line of the modules file should be "filesystem.squashfs"
    And the system partition should contain file "in_overlay_1"
    And the system partition should contain file "in_overlay_2"
    And the system partition should not contain file "a"
    And the system partition should not contain file "b/c"
    And the system partition should contain file "d"
    And the temporary directory on the system partition should be empty
    And the system partition should contain file "live/vmlinuz"
    And the system partition should contain file "live/initrd.img"

  Scenario: attempt to install an IUK while there is too little space available on the live medium
    Given a "test1.iuk" IUK whose overlay directory contains the 80MB file "in_overlay_1"
    When I install the "test1.iuk" IUK
    Then it should fail
    And the system partition should not contain file "in_overlay_1"
    And the temporary directory on the system partition should be empty
    And the modules file should list 1 SquashFS
    And the last line of the modules file should be "filesystem.squashfs"

  @syslinux
  Scenario: install an IUK that ships a syslinux binary and MBR
    Given a "test1.iuk" IUK whose overlay directory contains the files "utils/linux/syslinux" and "utils/mbr/mbr.bin" respectively copied from "/usr/bin/syslinux" and "/usr/lib/SYSLINUX/gptmbr.bin"
    When I install the "test1.iuk" IUK
    Then it should succeed
    And the system partition should contain file "utils/linux/syslinux"
    And the system partition should contain file "utils/mbr/mbr.bin"
    And the system partition should contain file "syslinux/ldlinux.sys"
    And the "syslinux/ldlinux.sys" file in the system partition has been modified less than 1 minute ago
    And the MBR is the new syslinux' one
