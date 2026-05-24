When /^GNOME offers me various screenshot options$/ do
  assert_not_nil(
    Dogtail::Application.new('gnome-shell').child('Screen')
  )
end

Then /^there is no screenshot in the live user's Pictures directory$/ do
  pictures_directory = "/home/#{LIVE_USER}/Pictures"
  assert(
    $vm.execute(
      "find '#{pictures_directory}' -name 'Screenshot*.png' -maxdepth 1"
    ).stdout.empty?,
    "Existing screenshots were found in the live user's Pictures directory."
  )
end

Then /^a screenshot is saved to the live user's Pictures directory$/ do
  pictures_directory = "/home/#{LIVE_USER}/Pictures/Screenshots"
  try_for(10, msg: "No screenshot was created in #{pictures_directory}") do
    !$vm.execute(
      "find '#{pictures_directory}' -name 'Screenshot*.png' -maxdepth 1"
    ).stdout.empty?
  end
end

When /^the "(.+)" notification is sent$/ do |title|
  $vm.execute_successfully("notify-send '#{title}'", user: LIVE_USER)
end

Then /^the "(.+)" notification is shown to the user$/ do |title|
  Dogtail::Application.new('gnome-shell').child(title)
end
