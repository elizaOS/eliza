@product @check_tor_leaks
Feature: Tor stream isolation is effective
  As a Tails user
  I want my Tor streams to be sensibly isolated from each other to prevent identity correlation

  Background:
    Given I have started Tails from DVD and logged in and the network is connected

  @not_release_blocker
  Scenario: tails-security-check is using the Tails-specific SocksPort
    When I monitor the network connections of tails-security-check
    And I re-run tails-security-check
    Then I see that tails-security-check is properly stream isolated after 10 seconds

  @not_release_blocker
  Scenario: htpdate is using the Tails-specific SocksPort
    When I monitor the network connections of htpdate
    And I re-run htpdate
    Then I see that htpdate is properly stream isolated

  @not_release_blocker
  Scenario: tails-upgrade-frontend-wrapper is using the Tails-specific SocksPort
    When I monitor the network connections of tails-upgrade-frontend-wrapper
    And I re-run tails-upgrade-frontend-wrapper
    Then I see that tails-upgrade-frontend-wrapper is properly stream isolated

  Scenario: The Tor Browser is using the web browser-specific SocksPort
    When I monitor the network connections of Tor Browser
    And I start the Tor Browser
    And I open the Tails homepage in the Tor Browser
    Then the Tor Browser loads the Tails homepage
    And I see that Tor Browser is properly stream isolated
