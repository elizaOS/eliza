@product
Feature: Using persistent Tor bridges and pluggable transports
  As a Tails user
  I want to save Tor bridges in Persistent Storage
  And be given the option to use them again

  Background:
    Given I have started Tails without network from a USB drive without a persistent partition and logged in
    And I create a persistent partition with the default settings
    Then the "TorConfiguration" tps feature is not enabled
    When the network is plugged
    And the Tor Connection Assistant autostarts
    And I configure some persistent obfs4 bridges in the Tor Connection Assistant
    And I wait until Tor is ready
    Then tca.conf includes the configured bridges
    And the "TorConfiguration" tps feature is enabled and active
    When I cold reboot the computer
    And the computer reboots Tails
    And I enable persistence
    And I capture all network traffic
    And I log in to a new session
    Then tca.conf includes the configured bridges
    When the network is plugged
    And the Tor Connection Assistant autostarts

  Scenario: Using Persistent Tor bridges
    When I choose to connect to Tor automatically
    And I accept Tor Connection's offer to use my persistent bridges
    And I click "Connect to Tor"
    Then I wait until Tor is ready
    And tca.conf includes the configured bridges
    And the "TorConfiguration" tps feature is enabled and active
    And all Internet traffic has only flowed through the configured bridges or connectivity check service

  Scenario: Disabling persistence of Tor bridges
    When I choose to connect to Tor automatically
    And I accept Tor Connection's offer to use my persistent bridges
    And I disable saving bridges to Persistent Storage
    And I configure a direct connection in the Tor Connection Assistant
    Then I wait until Tor is ready
    And tca.conf includes no bridge
    And the "TorConfiguration" tps feature is not enabled and not active
    And all Internet traffic has only flowed through Tor or connectivity check service
