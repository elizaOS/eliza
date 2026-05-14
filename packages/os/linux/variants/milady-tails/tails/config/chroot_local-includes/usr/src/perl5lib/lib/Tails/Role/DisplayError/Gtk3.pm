package Tails::Role::DisplayError::Gtk3;

use 5.10.1;
use strictures 2;
use autodie qw(:all);
use Function::Parameters;
use Types::Standard qw(InstanceOf Str);

use Moo::Role;
use namespace::clean;

requires 'encoding';

method display_error (
    (InstanceOf['Gtk3::Window']) $main_window,
    Str $title,
    Str $mesg
) {
    say STDERR $self->encoding->encode("$title: $mesg");

    my $dialog = Gtk3::MessageDialog->new(
        $main_window, 'destroy-with-parent', 'error', 'ok',
        $title
    );
    $dialog->set('secondary-text' => $mesg);
    $dialog->set_position('center');
    $dialog->run;
}

no Moo::Role;
1; # End of Tails::Role::DisplayError::Gtk3
