const entryForm = document.querySelector("#entry-form");
const guestNameInput = document.querySelector("#guest-name");
const entryScreen = document.querySelector("#entry-screen");
const rsvpYesLink = document.querySelector("#rsvp-yes");
const rsvpNoLink = document.querySelector("#rsvp-no");
const rsvpEmail = "samuelbumatay918@gmail.com";

entryForm.addEventListener("submit", (event) => {
	event.preventDefault();

	const guestName = guestNameInput.value.trim();
	if (!guestName) {
		guestNameInput.focus();
		return;
	}

	const createRsvpLink = (answer) => {
		const subject = `Hannah's Debut RSVP - ${answer}`;
		const body = `Hello,\n\nMy name is ${guestName}.\n${answer === "Yes, I'll be there" ? "I would love to attend" : "I'm unable to attend"} Hannah Joyce Bumatay's debut at Santa Maria Auditorium.\n\n${guestName}`;
		const params = new URLSearchParams({ subject, body });
		return `mailto:${rsvpEmail}?${params.toString()}`;
	};

	rsvpYesLink.href = createRsvpLink("Yes, I'll be there");
	rsvpNoLink.href = createRsvpLink("Sorry, I can't make it");
	entryScreen.classList.add("is-hidden");
	document.querySelector("#home").focus({ preventScroll: true });
});