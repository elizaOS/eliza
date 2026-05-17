@product
Feature: Untrusted partitions
  As a Tails user
  I don't want to touch other media than the one Tails runs from

  Scenario: Tails ignores a swap volume and another Tails that are on an internal hard drive
    Given a computer
    And I temporarily create a 100 MiB disk named "swap"
    And I create a gpt swap partition on disk "swap"
    And I plug SATA drive "swap"
    And I temporarily create a 7200 MiB disk named "live_hd"
    And I write the Tails USB image to disk "live_hd"
    And I plug SATA drive "live_hd"
    When I start Tails with network unplugged and I login
    Then a "swap" partition was detected by Tails on drive "swap"
    And drive "live_hd" is detected by Tails
    But Tails has no disk swap enabled
    And drive "live_hd" is not mounted

  Scenario: The Welcome Screen ignores Persistent Storage stored on a non-removable USB drive
    Given a computer
    And I temporarily create a 100 MiB disk named "fake_TailsData"
    And I create a gpt partition labeled "TailsData" with an ext4 filesystem encrypted with password "asdf" on disk "fake_TailsData"
    And I plug non-removable USB drive "fake_TailsData"
    When I start the computer
    And the computer boots Tails
    Then drive "fake_TailsData" is detected by Tails
    And Tails Greeter has not detected a persistence partition

  Scenario: The Welcome Screen ignores Persistent Storage stored on an internal hard drive
    Given a computer
    And I temporarily create a 100 MiB disk named "fake_TailsData"
    And I create a gpt partition labeled "TailsData" with an ext4 filesystem encrypted with password "asdf" on disk "fake_TailsData"
    And I plug SATA drive "fake_TailsData"
    When I start the computer
    And the computer boots Tails
    Then drive "fake_TailsData" is detected by Tails
    And Tails Greeter has not detected a persistence partition

  Scenario: Booting Tails does not automount untrusted partitions
    Given a computer
    And I temporarily create a 100 MiB disk named "gpt_ext2"
    And I create a gpt partition with an ext2 filesystem on disk "gpt_ext2"
    And I plug SATA drive "gpt_ext2"
    And I temporarily create a 100 MiB disk named "msdos_fat32"
    And I create an msdos partition with a vfat filesystem on disk "msdos_fat32"
    And I plug SATA drive "msdos_fat32"
    And I start Tails from DVD with network unplugged and I login
    Then drive "gpt_ext2" is detected by Tails
    And drive "gpt_ext2" is not mounted
    And drive "msdos_fat32" is detected by Tails
    And drive "msdos_fat32" is not mounted
