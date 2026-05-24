require 'yaml'

Given /^I have the build manifest for the image under test$/ do
  assert File.exist? TAILS_BUILD_MANIFEST
end

Then /^all packages listed in the build manifest are up-to-date$/ do
  command = "#{GIT_DIR}/bin/needed-package-updates"
  config = "#{GIT_DIR}/config/ci/needed-package-updates.yml"
  cmd_helper([command, "--config=#{config}", "--file=#{TAILS_BUILD_MANIFEST}"])
end

Then /^no Qt5 package is installed$/ do
  manifest = YAML.safe_load(File.read(TAILS_BUILD_MANIFEST))
  packages = manifest['packages']['binary'].map { |b| b['package'] }

  unwanted = ['qtwayland5', 'qttranslations5-l10n']
  qt5_packages_installed = packages.select do |p|
    p.include?('qt5') || unwanted.include?(p)
  end

  assert_empty(qt5_packages_installed,
               'No Qt5 packages should be installed, '\
               "#{qt5_packages_installed.count} found")
end
