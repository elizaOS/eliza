When /^I start Tails' custom backup tool$/ do
  launch_tails_backup
end

Then /^the backup tool displays "([^"]+)"$/ do |expected|
  try_for(60) do
    Dogtail::Application.new('zenity')
                        .children(roleName: 'label')
                        .any? { |n| n.text.include?(expected) }
  end
end

When /^I click "([^"]+)" in the backup tool$/ do |node|
  zenity_dialog_click_button('Back Up Persistent Storage', node)
end

When /^I enter my persistent storage passphrase into the polkit prompt$/ do
  deal_with_polkit_prompt(@persistence_password,
                          title: 'Enter a passphrase to unlock the volume')
end

Then /^the USB drive "([^"]+)" contains the same files as my persistent storage$/ do |disk_name|
  source_dir = '/live/persistence/TailsData_unlocked/'
  backup_dev = $vm.persistent_storage_dev_on_disk(disk_name)
  luks_mapping = "#{File.basename(backup_dev)}_unlocked"
  luks_dev = "/dev/mapper/#{luks_mapping}"
  backup_dir = "/mnt/#{luks_mapping}"
  $vm.execute("mkdir -p #{backup_dir}")
  begin
    $vm.execute_successfully("echo '#{@persistence_password}' | " \
                             "cryptsetup luksOpen #{backup_dev} #{luks_mapping}")
    begin
      $vm.execute_successfully("mount '#{luks_dev}' #{backup_dir}")
      # Below we exclude socket files which diff cannot handle
      c = $vm.execute('diff --brief --recursive ' \
                      "--exclude='S.gpg-agent*' --exclude='S.scdaemon' " \
                      "#{source_dir} #{backup_dir}")
      raise "The backup differs:\n#{c.stdout}" if c.failure?
    ensure
      $vm.execute("umount #{backup_dir}")
    end
  ensure
    $vm.execute("cryptsetup luksClose #{luks_mapping}")
  end
end
