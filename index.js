const express = require('express');
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const cors = require('cors');
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { query } = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const port = process.env.PORT || 5000;

// Middlewares;
// const whitelist = [
// 	'http://localhost:3000/',
// 	'https://https://dorctors-portrals.web.app/',
// 	'https://doctors-portal-demos.netlify.app/',
// ];
// const corsOptions = {
// 	origin: function (origin, callback) {
// 		if (!origin || whitelist.indexOf(origin) !== -1) {
// 			callback(null, true);
// 		} else {
// 			callback(new Error('Not allowed by CORS'));
// 		}
// 	},
// 	credentials: true,
// };
app.use(cors());
// app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
	res.send('hello from behind');
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.e9mltxe.mongodb.net/?retryWrites=true&w=majority`;

const client = new MongoClient(uri, {
	useNewUrlParser: true,
	useUnifiedTopology: true,
	serverApi: ServerApiVersion.v1,
});

function verifyJWT(req, res, next) {
	const authHeader = req.headers.authorization;

	if (!authHeader) {
		return res.status(401).send({ message: 'unauthorized access' });
	}
	const token = authHeader.split(' ')[1];
	jwt.verify(token, process.env.SECRET_ACCESS_TOKEN, (err, decoded) => {
		if (err) {
			return res.status(403).send({ message: 'forbidden access' });
		}
		req.decoded = decoded;

		next();
	});
}

const run = async () => {
	try {
		const doctorsDB = client.db('doctors-portal');
		const appointmentOptions = doctorsDB.collection('appointmentOptions');
		const bookingsCollection = doctorsDB.collection('bookings');
		const usersCollection = doctorsDB.collection('users');
		const doctorsCollection = doctorsDB.collection('doctors');
		const paymentsCollection = doctorsDB.collection('payments');

		// make sure you use verifyAdmin after verifyJWT

		const verifyAmin = async (req, res, next) => {
			const decodedEmail = req.decoded.email;
			const id = req.params.id;
			const query = { email: decodedEmail };
			const user = await usersCollection.findOne(query);
			if (user.role !== 'admin') {
				return res.status(403).send({ message: 'forbidden access' });
			}

			next();
		};
		/*

         random secure key jeneretor //* require('crypto').randomBytes(64).toString('hex')
        */

		app.get('/appointmentOptions', async (req, res) => {
			const date = req.query.date;
			// console.log(date);
			const options = await appointmentOptions.find({}).toArray();
			const bookingQuery = { appointmentDate: date };

			const alredyBooked = await bookingsCollection
				.find(bookingQuery)
				.toArray();

			options.forEach((option) => {
				const optionBooked = alredyBooked.filter(
					(booked) => booked.treatment === option.name
				);
				const bookedSlots = optionBooked.map((book) => book.slot);
				const remainingSlots = option.slots.filter(
					(slot) => !bookedSlots.includes(slot)
				);
				option.slots = remainingSlots;
			});

			res.send(options);
		});

		// Unauthorized

		app.get('/v2/appointmentOptions', async (req, res) => {
			const date = req.query.date;
			const options = await appointmentOptions
				.aggregate([
					{
						$lookup: {
							from: 'bookings',
							localField: 'name',
							foreignField: 'treatment',
							pipeline: [
								{
									$match: {
										$expr: {
											$eq: ['$appointmentDate', date],
										},
									},
								},
							],
							as: 'booked',
						},
					},
					{
						$project: {
							name: 1,
							price: 1,
							slots: 1,
							booked: {
								$map: {
									input: '$booked',
									as: 'book',
									in: '$$book.slot',
								},
							},
						},
					},
					{
						$project: {
							name: 1,
							price: 1,
							slots: {
								$setDifference: ['$slots', '$booked'],
							},
						},
					},
				])
				.toArray();
			res.send(options);
		});

		app.get('/appointmentSpecialty', async (req, res) => {
			const query = {};
			const result = await appointmentOptions
				.find(query)
				.project({ name: 1 })
				.toArray();
			res.send(result);
		});
		/*
		 * API NAMING Convention
		 * bookings
		 * app.get('/bookings')
		 * app.get('/bookings/:id')
		 * app.post('/bookings')
		 * app.patch('/bookings)
		 */

		app.get('/bookings', verifyJWT, async (req, res) => {
			const email = req.query.email;
			const decodedEmail = req.decoded.email;
			if (email !== decodedEmail) {
				return res.status(403).send({ message: 'forbidden access' });
			}

			const query = { email: email };
			const bookings = await bookingsCollection.find(query).toArray();
			res.send(bookings);
		});

		app.get('/booking/:id', async (req, res) => {
			const id = req.params.id;
			const query = { _id: ObjectId(id) };

			const payBooking = await bookingsCollection.findOne(query);

			res.send(payBooking);
		});

		app.post('/bookings', async (req, res) => {
			const booking = req.body;

			const query = {
				appointmentDate: booking.appointmentDate,
				treatment: booking.treatment,
				email: booking.email,
			};

			const alreadyBooked = await bookingsCollection.find(query).toArray();
			if (alreadyBooked.length) {
				const message = `You already have a booking an ${booking.appointmentDate}`;
				return res.send({ acknowledged: false, message });
			}
			const result = await bookingsCollection.insertOne(booking);
			res.send(result);
		});

		// |   payment method

		app.post('/create-payment-intent', verifyJWT, async (req, res) => {
			const booking = req.body;
			const price = booking.price;
			const amount = price * 100;

			const paymentIntent = await stripe.paymentIntents.create({
				currency: 'usd',
				amount: amount,
				payment_method_types: ['card'],
			});

			res.send({ clientSecret: paymentIntent.client_secret });
		});

		app.post('/payments', async (req, res) => {
			const payment = req.body;
			const result = await paymentsCollection.insertOne(payment);
			const _id = payment.bookingId;
			const filter = { _id: ObjectId(_id) };
			const updatedDoc = {
				$set: {
					paid: true,
					transactionId: payment.transactionId,
				},
			};
			const updatedResult = await bookingsCollection.updateOne(
				filter,
				updatedDoc
			);
			res.send(result);
		});

		app.get('/jwt', async (req, res) => {
			const email = req.query.email;
			const query = { email };

			const user = await usersCollection.findOne(query);

			if (user) {
				const token = jwt.sign({ email }, process.env.SECRET_ACCESS_TOKEN, {
					expiresIn: '1d',
				});
				return res.send({ accessToken: token });
			}
			// console.log(user);
			res.status(403).send({ accessToken: '' });
		});

		app.get('/users', async (req, res) => {
			const query = {};
			const users = await usersCollection.find(query).toArray();
			res.send(users);
		});

		app.post('/users', async (req, res) => {
			const user = req.body;
			const result = await usersCollection.insertOne(user);
			res.send(result);
		});
		app.get('/users/addmin/:email', async (req, res) => {
			const email = req.params.email;
			const query = { email: email };
			const user = await usersCollection.findOne(query);
			res.send({ isAdmin: user?.role === 'admin' });
		});
		app.put('/users/addmin/:id', verifyJWT, verifyAmin, async (req, res) => {
			const filter = { _id: ObjectId(req.params.id) };
			const option = { upsert: true };
			const updatedDoc = {
				$set: {
					role: 'admin',
				},
			};
			const result = await usersCollection.updateOne(
				filter,
				updatedDoc,
				option
			);

			res.send(result);
		});
		app.delete('/users/addmin/:id', verifyJWT, verifyAmin, async (req, res) => {
			const filter = { _id: ObjectId(req.params.id) };

			const result = await usersCollection.findOneAndDelete(filter);

			res.send(result);
		});

		//  temporary to udpate price field on appointment options

		// app.get('/addPrice', async (req, res) => {
		// 	const filter = {};
		// 	const options = { upsert: true };
		// 	const updatedDoc = {
		// 		$set: {
		// 			price: 99,
		// 		},
		// 	};
		// 	const result = await appointmentOptions.updateMany(
		// 		filter,
		// 		updatedDoc,
		// 		options
		// 	);

		// 	res.send(result);
		// });

		app.get('/doctors', verifyJWT, verifyAmin, async (req, res) => {
			const query = {};
			const doctors = await doctorsCollection.find(query).toArray();
			res.send(doctors);
		});

		app.post('/doctors', verifyJWT, verifyAmin, async (req, res) => {
			const doctor = req.body;
			const result = await doctorsCollection.insertOne(doctor);

			res.send(result);
		});
		app.delete('/doctors/:id', verifyJWT, verifyAmin, async (req, res) => {
			const id = req.params.id;
			const query = { _id: ObjectId(id) };
			const deleteDoctor = await doctorsCollection.deleteOne(query);

			res.send(deleteDoctor);
		});
	} finally {
	}
};
run().catch((err) => console.log(err));

app.listen(port, () => {
	console.log('server running at port', port);
});
