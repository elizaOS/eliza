def electrum_app
  Dogtail::Application.new('electrum')
end

def electrum_main
  electrum_app.child(roleName: 'frame')
end

def electrum_wizard
  electrum_app.child(roleName: 'dialog')
end

Then /^I start Electrum through the GNOME menu$/ do
  step 'I start "Electrum Bitcoin Wallet" via GNOME Activities Overview'
end

Then /^Electrum (?:has started|starts)$/ do
  try_for(60) do
    electrum_app
  end
end

When /^a bitcoin wallet is (|not )present$/ do |existing|
  wallet = "/home/#{LIVE_USER}/.electrum/wallets/default_wallet"
  case existing
  when ''
    step "the file \"#{wallet}\" exists after at most 30 seconds"
  when 'not '
    step "the file \"#{wallet}\" does not exist"
  else
    raise "Unknown value specified for #{existing}"
  end
end

Then /^I am prompted to (configure Electrum|enter my Electrum wallet password)$/ do |mode|
  try_for(30) do
    electrum_wizard.child('Electrum wallet', roleName: 'label')
  end
  case mode
  when 'configure Electrum'
    expected = "This file does not exist.\n" \
               "Press 'Next' to create this wallet, or choose another file."
  when 'enter my Electrum wallet password'
    expected = "This file is encrypted.\n" \
               'Enter your password or choose another file.'
  else
    raise 'Unsupported'
  end
  electrum_wizard.children(expected, roleName: 'label')
end

When /^I follow the Electrum wizard to create a new bitcoin wallet$/ do
  electrum_wizard.button('Next').press
  electrum_wizard.child('What kind of wallet do you want to create?',
                        roleName: 'panel')
  electrum_wizard.child('Standard wallet', roleName: 'radio button').click
  electrum_wizard.button('Next').press
  electrum_wizard.child('Keystore', roleName: 'label')
  electrum_wizard.child('Create a new seed', roleName: 'radio button').click
  electrum_wizard.button('Next').press
  electrum_wizard.child('Choose Seed type', roleName: 'label')
  electrum_wizard.child('Standard', roleName: 'radio button').click
  electrum_wizard.button('Next').press
  electrum_wizard.child('Your wallet generation seed is:', roleName: 'label')
  seed = electrum_wizard.child(roleName: 'text').text
  electrum_wizard.button('Next').press
  electrum_wizard.child('Confirm Seed', roleName: 'label')
  electrum_wizard.child(roleName: 'text').text = seed
  electrum_wizard.button('Next').press
  @electrum_password = 'asdf'
  electrum_wizard.children(roleName: 'password text').each do |n|
    n.grabFocus
    @screen.type(@electrum_password)
  end
  electrum_wizard.button('Next').press
end

Then /^I see a warning that Electrum is not persistent$/ do
  assert(
    Dogtail::Application.new('zenity')
      .children(roleName: 'label')
      .any? { |n| n.name.start_with?('Persistence is disabled for Electrum') }
  )
end

When /^I enter my Electrum wallet password$/ do
  electrum_wizard.child(roleName: 'password text').grabFocus
  @screen.type(@electrum_password)
  electrum_wizard.button('Next').press
end

Then /^I see the main Electrum client window$/ do
  electrum_main
end

Then /^Electrum successfully connects to the network$/ do
  electrum_statusbar = electrum_main.child(roleName: 'status bar')
  try_for(180) do
    electrum_statusbar.children(roleName: 'label').any? do |n|
      # The balance is shown iff we are connected.
      n.name.start_with?('Balance: ')
    end
  end
end
