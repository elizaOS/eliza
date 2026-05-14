Feature: download and verify an upgrade-description file
  As a Tails developer
  I work on the Tails upgrade system
  I want to make sure the upgrade-description downloader and verifier works properly

  Background:
    Given a usable temporary directory
    And a running "Tails", version "0.12", initially installed at version "0.11", targeted at "s390x", using channel "stable"
    And an HTTP random port
    And an HTTPS random port
    And a trusted Certificate Authority
    And a trusted OpenPGP signing key pair
    And an untrusted OpenPGP signing key pair

  Scenario: Failed download of a non-existing upgrade-description
    Given an HTTPS server with a valid SSL certificate
    And no upgrade-description that matches the initially installed Tails
    When I download and check this upgrade-description file
    Then it should fail
    And I should be told "Could not download"

  Scenario: Successful download and verification
    Given an HTTPS server with a valid SSL certificate
    And an upgrade-description that matches the initially installed Tails
    And a valid signature made by a trusted key
    When I download and check this upgrade-description file
    Then it should succeed
    And the upgrade-description content should be printed

  Scenario: Failed download due to untrusted SSL certificate
    Given an HTTPS server with an invalid SSL certificate
    And an upgrade-description that matches the initially installed Tails
    And a valid signature made by a trusted key
    When I download and check this upgrade-description file
    Then it should fail
    And I should be told "certificate verification failed|certificate error"

  Scenario: Failed download due to expired SSL certificate
    Given an HTTPS server with an expired SSL certificate
    And an upgrade-description that matches the initially installed Tails
    And a valid signature made by a trusted key
    When I download and check this upgrade-description file
    Then it should fail
    And I should be told "certificate verification failed|certificate has expired"

  Scenario: Failed download due to SSL certificate that is not valid yet
    Given an HTTPS server with a not-valid-yet SSL certificate
    And an upgrade-description that matches the initially installed Tails
    And a valid signature made by a trusted key
    When I download and check this upgrade-description file
    Then it should fail
    And I should be told "certificate verification failed|certificate error"

  Scenario: Failed download when server redirects to cleartext HTTP
    Given an HTTPS server with a valid SSL certificate, that redirects to 127.0.0.2 over cleartext HTTP
    And an HTTP server on 127.0.0.2
    And an upgrade-description that matches the initially installed Tails
    And a valid signature made by a trusted key
    When I download and check this upgrade-description file
    Then it should fail
    And I should be told "request failed"

  Scenario: Successful download, failed verification of an invalid signature made by a trusted key
    Given an HTTPS server with a valid SSL certificate
    And an upgrade-description that matches the initially installed Tails
    And an invalid signature made by a trusted key
    When I download and check this upgrade-description file
    Then it should fail
    And I should be told "Invalid signature"

  Scenario: Successful download, failed verification of valid signature made by an untrusted key
    Given an HTTPS server with a valid SSL certificate
    And an upgrade-description that matches the initially installed Tails
    And a valid signature made by an untrusted key
    When I download and check this upgrade-description file
    Then it should fail
    And I should be told "Invalid signature"

  Scenario: Successful download of the upgrade-description, failed download of the signature
    Given an HTTPS server with a valid SSL certificate
    And an upgrade-description that matches the initially installed Tails
    When I download and check this upgrade-description file
    Then it should fail
    And I should be told "Could not download"

  Scenario: Failed download of the upgrade-description from a non-existing server
    Given a non-existing web server
    When I download and check an upgrade-description file from this server
    Then it should fail
    And I should be told "Could not download"

  Scenario: Failed download of an upgrade-description that is bigger than expected
    Given an HTTPS server with a valid SSL certificate
    And an upgrade-description that is too big
    And a valid signature made by a trusted key
    When I download and check this upgrade-description file
    Then it should fail
    And I should be told "Maximum file size exceeded"

  Scenario: Failed download of a signature that is bigger than expected
    Given an HTTPS server with a valid SSL certificate
    And an upgrade-description that matches the initially installed Tails
    And a signature that is too big
    When I download and check this upgrade-description file
    Then it should fail
    And I should be told "Maximum file size exceeded"

  Scenario: Well-signed upgrade-description does not match the running Tails' product name
    Given an HTTPS server with a valid SSL certificate
    And an upgrade-description that has a different "product_name" than the running Tails
    And a valid signature made by a trusted key
    When I download and check this upgrade-description file
    Then it should fail
    And I should be told "Does not match running system"

  Scenario: Well-signed upgrade-description does not match the running Tails' initial install version
    Given an HTTPS server with a valid SSL certificate
    And an upgrade-description that has a different "initial_install_version" than the running Tails
    And a valid signature made by a trusted key
    When I download and check this upgrade-description file
    Then it should fail
    And I should be told "Does not match running system"

  Scenario: Well-signed upgrade-description does not match the running Tails' architecture
    Given an HTTPS server with a valid SSL certificate
    And an upgrade-description that has a different "build_target" than the running Tails
    And a valid signature made by a trusted key
    When I download and check this upgrade-description file
    Then it should fail
    And I should be told "Does not match running system"

  Scenario: Well-signed upgrade-description does not match the running Tails' channel
    Given an HTTPS server with a valid SSL certificate
    And an upgrade-description that has a different "channel" than the running Tails
    And a valid signature made by a trusted key
    When I download and check this upgrade-description file
    Then it should fail
    And I should be told "Does not match running system"
