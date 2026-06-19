@product
Feature: Logging in via SSH
  As a Tails user
  When I connect to SSH servers on the Internet
  all Internet traffic should flow only through Tor

  Background:
    Given I have started Tails from DVD and logged in and the network is connected

  @check_tor_leaks
  Scenario: Connecting to an SSH server on the Internet works and uses the default SocksPort
    Given I monitor the network connections of SSH
    And I have the SSH key pair for an SSH server
    When I connect to an SSH server on the Internet
    Then I have successfully logged into the SSH server
    And I see that SSH is properly stream isolated

  @check_tor_leaks
  Scenario: Connecting to an SSH server on the LAN
    Given I have the SSH key pair for an SSH server
    And an SSH server is running on the LAN
    When I connect to an SSH server on the LAN
    Then I am prompted to verify the SSH fingerprint for the SSH server
