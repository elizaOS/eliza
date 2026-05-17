@product @doc @not_release_blocker
Feature: Tails documentation

  Scenario: The Tails documentation launcher works when offline
    Given I have started Tails from DVD without network and logged in
    When I start "Tails Documentation" via GNOME Activities Overview
    Then the Tor Browser has started
    And "Tails - Documentation" has loaded in the Tor Browser

  Scenario: The Tails documentation launcher works when online
    Given I have started Tails from DVD and logged in and the network is connected
    When I start "Tails Documentation" via GNOME Activities Overview
    Then the Tor Browser has started
    And "Tails - Documentation" has loaded in the Tor Browser
