def onioncircuits
  Dogtail::Application.new('onioncircuits')
end

Then(/^Onion Circuits starts$/) do
  onioncircuits
end

Then(/^Onion Circuits shows some circuits$/) do
  # Check that the "You are not connected to Tor yet..." label is not present
  assert_raise(Dogtail::Failure) do
    onioncircuits.child('You are not connected to Tor yet...', retry: false)
  end

  # Check that a "Built" status label is present
  onioncircuits.child('Built')
end
