@product
Feature: Random Seed
  As a Tails user
  I want Tails to use secure random numbers

  Scenario: A random seed is read during boot and written during boot and shutdown
    Given a computer
    And I temporarily create a 7200 MiB disk named "temp"
    And I plug USB drive "temp"
    And I write the Tails USB image to disk "temp"
    Then there is no random seed on USB drive "temp"
    When I start Tails from USB drive "temp" with network unplugged
    Then the random seed was written multiple times on first boot
    And there is a random seed on USB drive "temp"
    When I log in to a new session
    And I wait for the random seed to be updated
    Then there is a random seed on USB drive "temp"
    And the random seed is different from the previous one
    And I shutdown Tails and wait for the computer to power off
    Then there is a random seed on USB drive "temp"
    And the random seed is different from the previous one
