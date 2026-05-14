def secrets
  Dogtail::Application.new('secrets')
end

Then(/^Secrets tries to open "([^"]*)"$/) do |path|
  secrets.child(File.basename(path), roleName: 'label')
end

Given(/^I have a "(.*[.]kdbx)" file in my home$/) do |filename|
  $vm.file_overwrite("/home/amnesia/#{filename}",
                     'not empty')
end
