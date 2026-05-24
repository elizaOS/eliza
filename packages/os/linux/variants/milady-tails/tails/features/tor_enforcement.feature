@product
Feature: The Tor enforcement is effective
  As a Tails user
  I want all direct Internet connections I do by mistake or applications do by misconfiguration or buggy leaks to be blocked
  And as a Tails developer
  I want to ensure that the automated test suite detects firewall leaks reliably

  Scenario: The firewall configuration is very restrictive
    Given I have started Tails from DVD and logged in and the network is connected
    Then the firewall's policy is to drop all IPv4 traffic
    And the firewall is configured to only allow the clearnet and debian-tor users to connect directly to the Internet over IPv4
    And the firewall's NAT rules only redirect traffic for the Unsafe Browser, Tor's TransPort, and DNSPort
    And the firewall is configured to block all external IPv6 traffic

  @doc
  Scenario: Anti test: Detecting TCP leaks from the Unsafe Browser with the firewall leak detector
    Given I have started Tails from DVD and logged in and the network is connected
    And I capture all network traffic
    When I successfully start the Unsafe Browser
    And I open the Tails homepage in the Unsafe Browser
    And the Tails homepage loads in the Unsafe Browser
    Then the firewall leak detector has detected leaks

  Scenario: Anti test: Detecting TCP leaks of DNS lookups with the firewall leak detector
    Given I have started Tails from DVD and logged in and the network is connected
    And I capture all network traffic
    And I disable Tails' firewall
    When I do a TCP DNS lookup of "torproject.org"
    Then the firewall leak detector has detected leaks

  Scenario: Anti test: Detecting UDP leaks of DNS lookups with the firewall leak detector
    Given I have started Tails from DVD and logged in and the network is connected
    And I capture all network traffic
    And I disable Tails' firewall
    When I do a UDP DNS lookup of "torproject.org"
    Then the firewall leak detector has detected leaks

  Scenario: Anti test: Detecting ICMP leaks of ping with the firewall leak detector
    Given I have started Tails from DVD and logged in and the network is connected
    And I capture all network traffic
    And I disable Tails' firewall
    When I send some ICMP pings
    Then the firewall leak detector has detected leaks

  @check_tor_leaks
  Scenario: The Tor enforcement is effective at blocking untorified TCP connection attempts
    Given I have started Tails from DVD and logged in and the network is connected
    When I open an untorified TCP connection to 1.2.3.4 on port 42
    Then the untorified connection fails
    And the untorified connection is logged as dropped by the firewall

  @check_tor_leaks
  Scenario: The Tor enforcement is effective at blocking untorified UDP connection attempts
    Given I have started Tails from DVD and logged in and the network is connected
    When I open an untorified UDP connection to 1.2.3.4 on port 42
    Then the untorified connection fails
    And the untorified connection is logged as dropped by the firewall

  @check_tor_leaks
  Scenario: The Tor enforcement is effective at blocking untorified ICMP connection attempts
    Given I have started Tails from DVD and logged in and the network is connected
    When I open an untorified ICMP connection to 1.2.3.4
    Then the untorified connection fails
    And the untorified connection is logged as dropped by the firewall

  Scenario: The system DNS is always set up to use Tor's DNSPort
    Given I have started Tails from DVD without network and logged in
    And the system DNS is using the local DNS resolver
    And the network is plugged
    And I successfully configure Tor
    Then the system DNS is still using the local DNS resolver
