@product
Feature: Using Tor bridges and pluggable transports
  As a Tails user
  I want to circumvent censorship of Tor by using Tor bridges and pluggable transports
  And avoid connecting directly to the Tor Network

  Background:
    Given I have started Tails from DVD without network and logged in
    And I capture all network traffic
    When the network is plugged
    Then the Tor Connection Assistant autostarts

  Scenario: Using normal bridges
    When I configure some normal bridges in the Tor Connection Assistant
    Then I wait until Tor is ready
    And tca.conf includes the configured bridges
    And available upgrades have been checked
    And all Internet traffic has only flowed through the configured bridges or connectivity check service

  Scenario: Using obfs4 pluggable transports
    When I configure some obfs4 bridges in the Tor Connection Assistant in hide mode
    Then I wait until Tor is ready
    And tca.conf includes the configured bridges
    And available upgrades have been checked
    And all Internet traffic has only flowed through the configured bridges

  Scenario: Using obfs4 pluggable transports from a QR code
    When I configure some obfs4 bridges from a QR code in the Tor Connection Assistant in hide mode
    Then I wait until Tor is ready
    And tca.conf includes the configured bridges
    And available upgrades have been checked
    And all Internet traffic has only flowed through the configured bridges

  @supports_real_tor
  Scenario: Default Tor bridges
    When I configure the default bridges in the Tor Connection Assistant
    Then I wait until Tor is ready
    And Tor is configured to use the default bridges
    And tca.conf includes no bridge
    And available upgrades have been checked
    And Tor is configured to use the default bridges
    And all Internet traffic has only flowed through the default bridges or connectivity check service

  Scenario: Fall back to default bridges if failing to connect directly to the Tor network
    Given the Tor network is blocked
    When I configure a direct connection in the Tor Connection Assistant
    Then I wait until Tor is ready
    And tca.conf includes no bridge
    And available upgrades have been checked
    And Tor is configured to use the default bridges
    And all Internet traffic has only flowed through the default bridges or connectivity check service

  Scenario: TCA can reconnect after a connection failure
    Given the Tor network and default bridges are blocked
    When I unsuccessfully configure a direct connection in the Tor Connection Assistant
    Then the Tor Connection Assistant reports that it failed to connect
    And tca.conf is empty
    Given the Tor network and default bridges are unblocked
    When I retry connecting to Tor
    Then I wait until Tor is ready
    And tca.conf includes no bridge
    And available upgrades have been checked
    And all Internet traffic has only flowed through Tor or connectivity check service

  @supports_real_tor
  Scenario: Normal bridges are not allowed in "Hide" mode
    When I try to configure some normal bridges in the Tor Connection Assistant in hide mode
    Then the Tor Connection Assistant complains that normal bridges are not allowed
    And I cannot click the "Connect to Tor" button

  Scenario: The same Tor configuration is applied when the network is reconnected
    Given I configure a direct connection in the Tor Connection Assistant
    And I wait until Tor is ready
    When I disconnect the network through GNOME
    And I connect the network through GNOME
    Then the Tor Connection Assistant autostarts
    And the Tor Connection Assistant connects to Tor
    And I wait until Tor is ready
    And Tor is using the same configuration as before
    And available upgrades have been checked
    And all Internet traffic has only flowed through Tor or connectivity check service

  Scenario: Reconnecting from an unblocked network to a blocked network displays an error
    Given I configure a direct connection in the Tor Connection Assistant
    And I wait until Tor is ready
    And I disconnect the network through GNOME
    And the Tor network and default bridges are blocked
    When I connect the network through GNOME
    Then the Tor Connection Assistant reports that it failed to connect

  Scenario: Tor Connection honors my choice of using default bridges on retry, too
    Given the Tor network and default bridges are blocked
    When I unsuccessfully configure some default bridges in the Tor Connection Assistant
    Then the Tor Connection Assistant reports that it failed to connect
    Given the Tor network and default bridges are unblocked
    When I retry connecting to Tor
    Then I wait until Tor is ready
    And Tor is configured to use the default bridges
    And all Internet traffic has only flowed through the default bridges or connectivity check service

  Scenario: Asking for mocked bridge settings with automatic region-detection in Tor Connection
    Given the Moat distributor responds with the default bridges
    When I configure Tor Connection to ask for bridge settings based on my location
    And I wait until Tor is ready
    And available upgrades have been checked
    Then Tor is configured to use the default bridges
    And all Internet traffic has only flowed through the default bridges or connectivity check service

  Scenario: Asking for bridge settings but receiving a mocked API error in Tor Connection
    Given the Moat distributor responds with an API error
    When I configure Tor Connection to ask for bridge settings based on my location
    Then the Tor Connection Assistant reports that it failed to connect
    And the Tor Connection Assistant reports the Moat API error

  Scenario: Asking for real bridge settings for the USA in Tor Connection
    Given no bridges are configured in torrc
    When I configure Tor Connection to ask for bridge settings for "United States of America"
    Then some real world bridges are eventually configured in torrc
