# This fails too loudly so let's run it on fewer branches (tails/tails#21316)
@source @fragile
Feature: Packages are up-to-date
  On Tails branches that use frozen APT sources,
  packages we install from frozen distributions (e.g. the Linux kernel
  installed from testing/sid),
  and packages forked from Debian that we install from our custom APT repository,
  can become outdated.
  As a Tails developer, I want to ensure we don't miss important updates.

  Scenario: All packages are up-to-date
    Given I have the build manifest for the image under test
    Then all packages listed in the build manifest are up-to-date
