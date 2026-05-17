@product
Feature: APT sources are correctly configured
  As a Tails user
  I want APT to be configured to use hidden services

  Scenario: APT sources are configured correctly
    Given a computer
    And I start Tails from DVD with network unplugged
    Then the only hosts in APT sources are "cloudfront.debian.net,deb.tails.boum.org,deb.torproject.org"
    And no proposed-updates APT suite is enabled
    And no experimental APT suite is enabled for deb.torproject.org
    And if releasing, no unversioned Tails APT source is enabled
    And if releasing, the tagged Tails APT source is enabled
