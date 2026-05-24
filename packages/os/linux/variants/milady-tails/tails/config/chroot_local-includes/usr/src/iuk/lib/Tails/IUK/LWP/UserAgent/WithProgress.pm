=head1 NAME

Tails::IUK::LWP::UserAgent::WithProgress - LWP::UserAgent subclass that displays progress information

=cut

package Tails::IUK::LWP::UserAgent::WithProgress;

use 5.10.1;
use strictures 2;
use autodie qw(:all);
use Carp::Assert;

use parent 'LWP::UserAgent';

sub new {
    my $class = shift;
    my $args  = shift;
    assert('HASH' eq ref $args);

    my $self = $class->SUPER::new(@_);
    while (my ($k, $v) = each(%{$args})) { $self->{$k} = $v; }
    bless($self, $class);

    return $self;
}

sub progress {
    # When $status is "begin", $request_or_response is the
    # HTTP::Request object, otherwise it is the HTTP::Response object.
    my $self = shift;

    if (-e $self->{temp_file}) {
        say(100 * (-s $self->{temp_file}) / $self->{size});
    }
    else {
        say "0";
    }

    STDOUT->flush;
}

1;
