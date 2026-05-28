@product @check_tor_leaks
Feature: Cloning a Git repository
  As a Tails user
  when I clone a Git repository
  all Internet traffic should flow only through Tor

  Background:
    Given I have started Tails from DVD and logged in and the network is connected

  Scenario: Cloning a Git repository anonymously over HTTPS
    When I clone the Git repository "https://github.com/intrigeri/Dist-Zilla-Plugin-LocaleMsgfmt.git" in Console
    Then the Git repository "Dist-Zilla-Plugin-LocaleMsgfmt" has been cloned successfully

  Scenario: Cloning git repository over SSH
    Given I have the SSH key pair for a Git repository
    When I clone the Git repository "ssh://gitolite3@lizard.tails.boum.org:3004/myprivatekeyispublic/testing.git" in Console
    Then the Git repository "testing" has been cloned successfully
