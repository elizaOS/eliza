@product
Feature: Networking

  Scenario: No initial network
    Given I have started Tails from DVD without network and logged in
    And I wait between 30 and 60 seconds
    Then the Tor Status icon tells me that Tor is not usable
    When the network is plugged
    Then I successfully configure Tor
    And the Tor Status icon tells me that Tor is usable
    And all notifications have disappeared
    And the time has synced

  @not_release_blocker
  Scenario: The Tails Greeter "disable all networking" option disables networking within Tails
    Given I have started Tails from DVD without network and stopped at Tails Greeter's login screen
    And I disable networking in Tails Greeter
    And I log in to a new session
    Then no network interfaces are enabled
    When I hotplug a network device
    And I wait 10 seconds
    Then no network interfaces are enabled
